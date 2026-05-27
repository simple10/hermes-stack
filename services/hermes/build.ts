// services/hermes/build.ts — TS port of services/hermes/build.sh.
//
// Provisions an OrbStack Ubuntu machine running Hermes wired to the
// Dockerized Honcho+LiteLLM stack. Installs ONLY messaging/agent services
// (dashboard, gateway, logtail) — NO native honcho/postgres (Honcho is
// Dockerized).
//
// HARD SAFETY: refuses the frozen original `hermes-agent`.
//
// The bash version lives at services/hermes/build.sh and remains the
// production driver while this port matures.  Both write the same kind of
// artifacts (~/.hermes/{.env,config.yaml,honcho.json,…}, systemd units in
// /etc/systemd/system/, /usr/local/bin/hermes-logtail.sh).  The TS port
// targets the parallel test stack: STACK_DIR=.stack-node, so
// HERMES_VIRTUAL_KEY/HERMES_GATEWAY_API_KEY/etc come from
// .stack-node/.env not .stack/.env.
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'

import { STACK_ROOT } from '../../scripts/lib/paths.ts'
import { stackProject, stackVmName } from '../../scripts/lib/compose-env.ts'
import { stackGet } from '../../scripts/lib/stack.ts'
import { envGet, envUpsert } from '../../scripts/lib/env.ts'
import { generatedGet, generatedUpsert, generatedEnvPath } from '../../scripts/lib/generated.ts'
import {
  orbExec,
  orbExecWithStdin,
  orbMachineExists,
  orbSetMachineIsolation,
  orbMountIsActive,
  orbShell,
} from '../../scripts/lib/orb.ts'
import { writeManagedBlock } from '../../scripts/lib/hermes-env.ts'
import { die, log, warn } from '../../scripts/lib/log.ts'

const SVC = 'hermes'
const D = resolve(STACK_ROOT, 'services/hermes')

interface Ctx {
  vm: string
  project: string
  remoteUser: string
  hermesVirtualKey: string
  mountEnabled: boolean
  macHermes: string // mac-side ~/.hermes location
  vmHermes: string // VM-side ~/.hermes location (e.g. /home/hermes/.hermes)
  orbMountSpec: string
}

const resolveCtx = (): Ctx => {
  if (SVC === ('hermes-agent' as string)) die("REFUSING: 'hermes-agent' is the frozen original.")
  const project = stackProject()
  const vm = stackVmName(SVC)
  const remoteUser = stackGet('HERMES_REMOTE_USER') || 'hermes'
  const hermesVirtualKey = generatedGet('litellm', 'HERMES_VIRTUAL_KEY')
  if (!hermesVirtualKey) {
    warn('HERMES_VIRTUAL_KEY not minted yet — start.ts will apply it post-mint')
  }
  const mountEnabled = (stackGet('HERMES_MOUNT_ENABLED') || 'true') === 'true'
  const mountDir = stackGet('HERMES_MOUNT_DIR') || '.stack-node/hermes/.hermes'
  const macHermes = mountDir.startsWith('/') ? mountDir : resolve(STACK_ROOT, mountDir)
  const vmHermes = `/home/${remoteUser}/.hermes`
  return {
    vm,
    project,
    remoteUser,
    hermesVirtualKey,
    mountEnabled,
    macHermes,
    vmHermes,
    orbMountSpec: `${macHermes}:${vmHermes}`,
  }
}

const hermesWrite = (ctx: Ctx, rel: string, content: string): void => {
  if (!ctx.mountEnabled) {
    warn(
      `skip ~/.hermes/${rel} (HERMES_MOUNT_ENABLED=false). apply manually with: orb -m ${ctx.vm} bash -lc 'umask 077 && mkdir -p ~/.hermes/$(dirname ${JSON.stringify(rel)}) && cat > ~/.hermes/${rel}'`,
    )
    return
  }
  const target = resolve(ctx.macHermes, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

const resolveMountConfig = (ctx: Ctx): void => {
  log(`0. resolve hermes mount config
   HERMES_MOUNT_ENABLED=${ctx.mountEnabled}
   HERMES_MOUNT_DIR=${stackGet('HERMES_MOUNT_DIR') || '.stack-node/hermes/.hermes'}
   resolves to: ${ctx.orbMountSpec}`)
  if (!ctx.mountEnabled) return
  mkdirSync(ctx.macHermes, { recursive: true })
}

const refuseToShadow = async (ctx: Ctx): Promise<void> => {
  if (!ctx.mountEnabled) return
  if (!(await orbMachineExists(ctx.vm))) return
  let vmHasData = false
  try {
    await orbExec(ctx.vm, 'test -s ~/.hermes/config.yaml')
    vmHasData = true
  } catch {
    /* no live config */
  }
  const macConfig = resolve(ctx.macHermes, 'config.yaml')
  const macHasConfig = existsSync(macConfig) && statSync(macConfig).size > 0
  if (vmHasData && !macHasConfig) {
    die(`HERMES_MOUNT_ENABLED=true but ${ctx.macHermes} is empty (no config.yaml)
   AND the VM has an existing ~/.hermes/. Refusing — the mount would shadow live data.

   Migrate first:
     1. stack-cli stop
     2. mkdir -p ${ctx.macHermes}
     3. cp -a ~/OrbStack/${ctx.vm}${ctx.vmHermes}/. ${ctx.macHermes}/
     4. rm -rf ${ctx.macHermes}/hermes-agent
     5. stack-cli build && stack-cli restart`)
  }
}

const ensureOrbMachine = async (ctx: Ctx): Promise<void> => {
  log(
    `1. orb create ubuntu ${ctx.vm} (--user ${ctx.remoteUser} --isolated --isolate-network; reuse if exists)`,
  )
  if (await orbMachineExists(ctx.vm)) {
    log(
      `machine ${ctx.vm} exists — reusing (REMOTE_USER=${ctx.remoteUser} must match the unix user inside the VM)`,
    )
    const rc = await orbSetMachineIsolation(ctx.vm)
    if (rc === 1)
      warn(
        `machine ${ctx.vm}: isolation flags were FALSE — flipped to true. Run 'stack-cli restart' to apply.`,
      )
    else if (rc === 2) die(`machine ${ctx.vm}: 'orb config set' failed (is OrbStack running?)`)
    if (ctx.mountEnabled) {
      try {
        await orbShell`orb config add ${`machine.${ctx.vm}.mounts`} ${ctx.orbMountSpec}`
      } catch {
        /* already set */
      }
      if (!(await orbMountIsActive(ctx.vm, ctx.vmHermes))) {
        die(
          `mount '${ctx.orbMountSpec}' configured but not yet applied — run 'stack-cli restart' to cycle the VM`,
        )
      }
    }
    return
  }
  if (ctx.mountEnabled) {
    await orbShell`orb create --user ${ctx.remoteUser} --isolated --isolate-network --mount ${ctx.orbMountSpec} ubuntu ${ctx.vm}`
  } else {
    await orbShell`orb create --user ${ctx.remoteUser} --isolated --isolate-network ubuntu ${ctx.vm}`
  }
}

const installSystemPackages = async (ctx: Ctx): Promise<void> => {
  log('2. apt xz-utils (REQUIRED — Hermes installer extracts Node .tar.xz)')
  // Fix /home/<user> ownership when orb created the dir as root because
  // the bind-mount target (/home/<user>/.hermes) was provisioned first.
  // No-op when ownership is already correct.
  await orbExec(ctx.vm, `sudo chown -R ${ctx.remoteUser}:${ctx.remoteUser} /home/${ctx.remoteUser}`)
  // git: required by the hermes installer's clone step. Some upstream
  // versions of install.sh refuse to proceed without it (newer than the
  // bash build.sh tested against — caught here when porting).
  await orbExec(
    ctx.vm,
    'sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xz-utils curl ca-certificates git',
    { stdio: 'inherit' },
  )
}

const hardenVm = async (ctx: Ctx): Promise<void> => {
  log('2b. VM hardening — remove cups snap if installed')
  try {
    await orbExec(
      ctx.vm,
      'snap list cups >/dev/null 2>&1 && { echo "removing cups snap"; sudo snap remove cups; } || echo "cups snap not installed — skipping"',
      { stdio: 'inherit' },
    )
  } catch {
    /* ok */
  }
}

const installHermes = async (ctx: Ctx): Promise<void> => {
  log('3. install Hermes (HERMES_INSTALL_DIR=/opt/hermes-agent)')
  // The installer's git clone runs as the invoking user (not root). It
  // needs /opt itself to be writable by them, AND /opt/hermes-agent to
  // not exist as an empty dir (the installer refuses to clone into a
  // non-empty/empty pre-existing dir).
  await orbExec(
    ctx.vm,
    [
      `sudo chown ${ctx.remoteUser}:${ctx.remoteUser} /opt`,
      `if [ -d /opt/hermes-agent ] && [ -z "$(ls -A /opt/hermes-agent 2>/dev/null)" ]; then rmdir /opt/hermes-agent; fi`,
    ].join(' && '),
  )
  await orbExec(
    ctx.vm,
    'command -v hermes >/dev/null 2>&1 || curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | HERMES_INSTALL_DIR=/opt/hermes-agent bash',
    { stdio: 'inherit' },
  )
  await orbExec(
    ctx.vm,
    `sudo ln -sf /home/${ctx.remoteUser}/.local/bin/hermes /usr/local/bin/hermes`,
  )
}

const subst = (body: string, vars: Record<string, string>): string =>
  body
    .replace(/__([A-Z][A-Z0-9_]*)__/g, (_, k) => vars[k] ?? '')
    .replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, k) => vars[k] ?? `\${${k}}`)

const configureMemory = async (ctx: Ctx, managed: string[]): Promise<string> => {
  const mem = stackGet('HERMES_MEMORY') || 'honcho'
  log(`4. configure Hermes memory provider: ${mem}`)
  const profiles = envGet(STACK_ROOT + '/.stack-node/.env', 'COMPOSE_PROFILES')
    .split(',')
    .map((x) => x.trim())
  switch (mem) {
    case 'default':
      log("memory: leaving Hermes' own default untouched")
      break
    case 'honcho': {
      if (!profiles.includes('honcho'))
        warn("HERMES_MEMORY=honcho but 'honcho' not in COMPOSE_PROFILES")
      const tpl = readFileSync(resolve(D, 'config/honcho.json.tmpl'), 'utf8')
      hermesWrite(ctx, 'honcho.json', subst(tpl, { STACK_PROJECT: ctx.project }))
      await orbExec(ctx.vm, 'hermes config set memory.provider honcho', { stdio: 'inherit' })
      log(`memory: honcho -> honcho-api.${ctx.project}.orb.local:8000`)
      break
    }
    case 'hindsight': {
      if (!profiles.includes('hindsight'))
        warn("HERMES_MEMORY=hindsight but 'hindsight' not in COMPOSE_PROFILES")
      const tpl = readFileSync(resolve(D, 'config/hindsight.config.json.tmpl'), 'utf8')
      hermesWrite(ctx, 'hindsight/config.json', subst(tpl, { STACK_PROJECT: ctx.project }))
      await orbExec(ctx.vm, 'hermes config set memory.provider hindsight', { stdio: 'inherit' })
      log(`memory: hindsight -> hindsight.${ctx.project}.orb.local:8888`)
      break
    }
    case 'holographic':
      await orbExec(ctx.vm, 'hermes config set memory.provider holographic', { stdio: 'inherit' })
      log('memory: holographic (fully local)')
      break
    case 'agentmemory': {
      if (!profiles.includes('agentmemory'))
        warn("HERMES_MEMORY=agentmemory but 'agentmemory' not in COMPOSE_PROFILES")
      managed.push(`AGENTMEMORY_URL=http://agentmemory.${ctx.project}.orb.local:3111`)
      managed.push(`AGENTMEMORY_SECRET=${stackGet('AGENTMEMORY_SECRET')}`)
      await orbExec(ctx.vm, 'hermes config set memory.provider agentmemory', { stdio: 'inherit' })
      // YAML merge: mcp_servers.agentmemory + memory.provider — done with
      // the `yaml` lib (preserves comments).
      if (ctx.mountEnabled) {
        const cfgPath = resolve(ctx.macHermes, 'config.yaml')
        const cfg = existsSync(cfgPath) ? (yamlParse(readFileSync(cfgPath, 'utf8')) ?? {}) : {}
        const root = cfg as Record<string, unknown>
        const ms = (root.mcp_servers ?? {}) as Record<string, unknown>
        ms.agentmemory = { command: 'npx', args: ['-y', '@agentmemory/mcp'] }
        root.mcp_servers = ms
        const memBlock = (root.memory ?? {}) as Record<string, unknown>
        memBlock.provider = 'agentmemory'
        root.memory = memBlock
        writeFileSync(cfgPath, yamlStringify(root, { lineWidth: 0 }))
        log('config.yaml: mcp_servers.agentmemory + memory.provider merged (Mac-side)')
      } else {
        warn(
          'agentmemory config.yaml merge skipped (mount disabled). Apply manually inside the VM.',
        )
      }
      log(`memory: agentmemory -> agentmemory.${ctx.project}.orb.local:3111`)
      break
    }
    default:
      die(`unknown HERMES_MEMORY='${mem}' (use: default|honcho|hindsight|agentmemory|holographic)`)
  }
  return mem
}

const wireOptionalServices = async (ctx: Ctx, managed: string[]): Promise<void> => {
  const profiles = envGet(STACK_ROOT + '/.stack-node/.env', 'COMPOSE_PROFILES')
    .split(',')
    .map((x) => x.trim())
  if (profiles.includes('firecrawl')) {
    managed.push(`FIRECRAWL_API_URL=http://firecrawl-api.${ctx.project}.orb.local:3002`)
    managed.push('FIRECRAWL_API_KEY=fc-selfhost-noauth')
    log(`firecrawl: FIRECRAWL_API_URL -> managed .env block`)
  } else {
    warn('firecrawl not in COMPOSE_PROFILES — skipping Hermes firecrawl env')
  }
  if (profiles.includes('camofox-browser')) {
    managed.push(`CAMOFOX_URL=http://camofox-browser.${ctx.project}.orb.local:9377`)
    log(`camofox: CAMOFOX_URL -> managed .env block`)
  } else {
    warn('camofox-browser not in COMPOSE_PROFILES — skipping Hermes camofox env')
  }
  if (profiles.includes('searxng')) {
    managed.push(`SEARXNG_URL=http://searxng.${ctx.project}.orb.local:8080`)
    await orbExec(ctx.vm, 'hermes config set web.search_backend searxng', { stdio: 'inherit' })
    log(`searxng: SEARXNG_URL -> managed .env block (web.search_backend=searxng)`)
  } else {
    warn('searxng not in COMPOSE_PROFILES — skipping Hermes searxng env')
  }
}

const patchModelBlock = (ctx: Ctx): void => {
  log(
    `5. patch config.yaml model: block (litellm.${ctx.project}.orb.local; key via stdin, never argv)`,
  )
  const hm = stackGet('HERMES_MODEL') || 'cliproxy/gpt-5.5'
  const tpl = readFileSync(resolve(D, 'config/config.yaml.model.tmpl'), 'utf8')
  const modelBlock = subst(tpl, {
    STACK_PROJECT: ctx.project,
    HERMES_MODEL: hm,
    HERMES_VIRTUAL_KEY: ctx.hermesVirtualKey,
  })
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
  if (!ctx.mountEnabled) {
    warn('skip config.yaml model: block patch (HERMES_MOUNT_ENABLED=false)')
    return
  }
  const cfgPath = resolve(ctx.macHermes, 'config.yaml')
  if (existsSync(cfgPath)) writeFileSync(cfgPath + '.bak.prebuild', readFileSync(cfgPath))
  const body = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : ''
  const lines = body.split('\n')
  const out: string[] = []
  let replaced = false
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (ln.trimEnd() === 'model:' || ln.startsWith('model:')) {
      // Skip the existing model: block (indented children + blanks).
      i++
      while (i < lines.length && (lines[i].startsWith(' ') || lines[i].trim() === '')) i++
      i-- // step back; for-loop increment will move past
      out.push(modelBlock.trimEnd())
      replaced = true
      continue
    }
    out.push(ln)
  }
  if (!replaced) out.unshift(modelBlock.trimEnd())
  writeFileSync(cfgPath, out.join('\n').replace(/\n*$/, '') + '\n')
  log('model: block patched (Mac-side)')
}

const installUnits = async (ctx: Ctx): Promise<void> => {
  log('6. install systemd units + logtail')
  const dashboardOn = (stackGet('HERMES_LOGTAIL_DASHBOARD') || 'false') === 'true'
  const logtailLine = dashboardOn
    ? 'journalctl -fu hermes-dashboard -n0 -o cat 2>/dev/null | sed -u "s/^/[hermes-dashboard] /" > /dev/console &'
    : '# hermes-dashboard journal tail disabled (HERMES_LOGTAIL_DASHBOARD=false)'

  const logtailTpl = readFileSync(resolve(D, 'bin/hermes-logtail.sh'), 'utf8')
  const logtail = logtailTpl
    .replace(/__REMOTE_USER__/g, ctx.remoteUser)
    .replace(/__LOGTAIL_DASHBOARD_LINE__/g, logtailLine)
  await orbExecWithStdin(
    ctx.vm,
    'sudo tee /usr/local/bin/hermes-logtail.sh >/dev/null && sudo chmod +x /usr/local/bin/hermes-logtail.sh',
    logtail,
  )
  for (const unit of ['hermes-dashboard', 'hermes-gateway', 'hermes-logtail']) {
    const tpl = readFileSync(resolve(D, `systemd/${unit}.service`), 'utf8').replace(
      /__REMOTE_USER__/g,
      ctx.remoteUser,
    )
    await orbExecWithStdin(ctx.vm, `sudo tee /etc/systemd/system/${unit}.service >/dev/null`, tpl)
  }
}

const applyGatewayGate = async (ctx: Ctx): Promise<void> => {
  log(
    '7. HERMES_GATEWAY_ALLOW_ACCESS gate (drop-in survives `hermes gateway restart --system` rewrites)',
  )
  const allow = (stackGet('HERMES_GATEWAY_ALLOW_ACCESS') || 'false') === 'true'
  const dropInDir = '/etc/systemd/system/hermes-gateway.service.d'
  const dropIn = `${dropInDir}/stack-api-server.conf`
  if (allow) {
    const apiKey = stackGet('HERMES_GATEWAY_API_KEY')
    if (!apiKey) {
      die(
        "HERMES_GATEWAY_ALLOW_ACCESS=true but HERMES_GATEWAY_API_KEY is empty. Run 'stack-cli setup' to mint it.",
      )
    }
    await orbExec(ctx.vm, `sudo mkdir -p ${dropInDir}`)
    const conf = `[Service]\nEnvironment="API_SERVER_ENABLED=true"\nEnvironment="API_SERVER_HOST=0.0.0.0"\nEnvironment="API_SERVER_PORT=8642"\nEnvironment="API_SERVER_KEY=${apiKey}"\n`
    await orbExecWithStdin(
      ctx.vm,
      `sudo tee ${dropIn} >/dev/null && sudo chmod 600 ${dropIn}`,
      conf,
    )
    generatedUpsert('hermes', 'HERMES_GATEWAY_URL', `http://${ctx.vm}.orb.local:8642`)
    generatedUpsert('hermes', 'HERMES_DASHBOARD_URL', `http://${ctx.vm}.orb.local:9119`)
    log(
      `gateway: gate OPEN — drop-in installed; HERMES_GATEWAY_URL=http://${ctx.vm}.orb.local:8642`,
    )
  } else {
    await orbExec(ctx.vm, `sudo rm -f ${dropIn}`)
    const gen = generatedEnvPath('hermes')
    let removed = false
    if (existsSync(gen)) {
      const body = readFileSync(gen, 'utf8')
      let next = body
      for (const k of ['HERMES_GATEWAY_URL', 'HERMES_DASHBOARD_URL']) {
        const re = new RegExp(`^${k}=.*$\n?`, 'm')
        if (re.test(next)) {
          next = next.replace(re, '')
          removed = true
        }
      }
      if (next !== body) writeFileSync(gen, next)
    }
    log(
      `gateway: gate CLOSED — ${removed ? 'removed drop-in + stale HERMES_*_URL' : 'loopback-only (default)'}`,
    )
  }
}

const materializeManagedEnv = (ctx: Ctx, managed: string[]): void => {
  if (!ctx.mountEnabled) {
    warn('skip ~/.hermes/.env managed-block rewrite (HERMES_MOUNT_ENABLED=false)')
    return
  }
  const content = managed.join('\n')
  writeManagedBlock(resolve(ctx.macHermes, '.env'), content)
  log(
    `~/.hermes/.env managed block rewritten (${managed.length} keys; user lines outside markers preserved)`,
  )
}

export default async function build(): Promise<void> {
  const ctx = resolveCtx()
  resolveMountConfig(ctx)
  await refuseToShadow(ctx)
  await ensureOrbMachine(ctx)
  await installSystemPackages(ctx)
  await hardenVm(ctx)
  await installHermes(ctx)

  // Accumulate the managed-block content across the conditional sections.
  const managed: string[] = [
    `OPENROUTER_API_KEY=${stackGet('OPENROUTER_API_KEY')}`,
    `TELEGRAM_BOT_TOKEN=${stackGet('HERMES_TELEGRAM_BOT_TOKEN')}`,
    `TELEGRAM_ALLOWED_USERS=${stackGet('HERMES_TELEGRAM_ALLOWED_USERS')}`,
    `TELEGRAM_HOME_CHANNEL=${stackGet('HERMES_TELEGRAM_HOME_CHANNEL')}`,
  ]
  await configureMemory(ctx, managed)
  await wireOptionalServices(ctx, managed)
  materializeManagedEnv(ctx, managed)
  patchModelBlock(ctx)
  await installUnits(ctx)
  await applyGatewayGate(ctx)

  // Persist any pgmt env back into .stack-node/.env if needed (currently no-op
  // beyond what stackUpsert already does inline).
  void envUpsert
  log(`services/hermes/build.ts DONE for '${ctx.vm}'`)
}
