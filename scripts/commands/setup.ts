// commands/setup.ts — interactive setup flow (clack-driven).
//
// Mirrors the responsibilities of lib/setup.sh:
//   1. Seed .stack-node/.env from .stack.defaults.env (first run = copy;
//      subsequent = additive merge of missing keys).
//   2. Prompt the user for COMPOSE_PROJECT_NAME.
//   3. Multi-select which services to enable (docker + VM lists), with
//      transitive SERVICE_REQUIRES cascade.
//   4. Prompt for provider API keys (OpenRouter, Voyage).
//   5. Conditionally gen secrets / prompt for hermes Telegram fields,
//      gated on which services are enabled.
//   6. Print a summary + "next steps".
import { existsSync, copyFileSync, chmodSync } from 'node:fs'
import * as p from '@clack/prompts'
import pc from 'picocolors'

import { STACK_ENV, DEFAULTS_ENV } from '../lib/paths.ts'
import { envGet, envUpsert, parseEnvFile } from '../lib/env.ts'
import { ensureStackDir, enableService, stackUpsert } from '../lib/stack.ts'
import { listServices, type ServiceDescriptor } from '../lib/services.ts'
import { genIfMissing } from '../lib/secrets.ts'

export const runSetup = async (): Promise<void> => {
  p.intro(pc.bgCyan(pc.black(' hermes-stack setup ')))
  ensureStackDir()

  // -- step 1: seed .stack-node/.env from defaults --------------------------
  if (!existsSync(STACK_ENV)) {
    copyFileSync(DEFAULTS_ENV, STACK_ENV)
    chmodSync(STACK_ENV, 0o600)
    p.log.step(`created ${STACK_ENV} from .stack.defaults.env`)
  } else {
    const defaults = parseEnvFile(DEFAULTS_ENV)
    const seeded: string[] = []
    for (const [k, v] of Object.entries(defaults)) {
      if (!envGet(STACK_ENV, k)) {
        envUpsert(STACK_ENV, k, v)
        seeded.push(k)
      }
    }
    if (seeded.length) p.log.step(`seeded missing keys from defaults: ${seeded.join(', ')}`)
  }

  // -- step 2: project identity --------------------------------------------
  const curProject = envGet(STACK_ENV, 'COMPOSE_PROJECT_NAME') || 'aitools'
  const project = await p.text({
    message: 'Compose project name (scopes containers/volumes/network)',
    placeholder: curProject,
    defaultValue: curProject,
    validate: (v) => {
      if (!v) return undefined // defaultValue kicks in
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(v))
        return 'lowercase letters/digits/_/- only; must start with alnum'
      return undefined
    },
  })
  if (p.isCancel(project)) return cancel()
  envUpsert(STACK_ENV, 'COMPOSE_PROJECT_NAME', project as string)

  // -- step 3: service selection -------------------------------------------
  const allServices = listServices()
  const dockerOpts = allServices
    .filter((s) => s.runner === 'docker' && s.kind !== 'backend')
    .map(toOption)
  const vmOpts = allServices.filter((s) => s.runner === 'vm').map(toOption)

  const curDocker = csv(envGet(STACK_ENV, 'COMPOSE_PROFILES'))
  const curVm = csv(envGet(STACK_ENV, 'STACK_MACHINES'))

  const dockerPick = await p.multiselect({
    message: `Docker services to enable\n${pc.dim('  space to toggle · enter to continue')}`,
    options: dockerOpts,
    initialValues: curDocker,
    required: false,
  })
  if (p.isCancel(dockerPick)) return cancel()

  const vmPick = await p.multiselect({
    message: `VM services to enable (blank ok)\n${pc.dim('  space to toggle · enter to continue')}`,
    options: vmOpts,
    initialValues: curVm,
    required: false,
  })
  if (p.isCancel(vmPick)) return cancel()

  // Overwrite the CSVs with the user's picks BEFORE cascade-enable so
  // any previously-listed-but-unselected service is dropped here, then
  // re-added if a kept service transitively requires it.
  envUpsert(STACK_ENV, 'COMPOSE_PROFILES', '')
  envUpsert(STACK_ENV, 'STACK_MACHINES', '')

  const allPicks = [...(vmPick as string[]), ...(dockerPick as string[])]
  const cascadeMsgs: string[] = []
  for (const svc of allPicks) {
    enableService(svc, (m) => cascadeMsgs.push(m))
  }
  for (const m of cascadeMsgs) p.log.info(m)

  // -- step 4: provider API keys (top-level, always asked) -----------------
  p.log.step('Provider API keys')
  const orCur = envGet(STACK_ENV, 'OPENROUTER_API_KEY')
  const orVal = await p.password({
    message: orCur
      ? 'OpenRouter API key (press enter to keep current)'
      : 'OpenRouter API key (fallback gateway when ChatGPT-sub quota hits)',
    mask: '•',
  })
  if (p.isCancel(orVal)) return cancel()
  if (typeof orVal === 'string' && orVal.length > 0)
    envUpsert(STACK_ENV, 'OPENROUTER_API_KEY', orVal)

  const voCur = envGet(STACK_ENV, 'VOYAGE_API_KEY')
  const voVal = await p.password({
    message: voCur ? 'Voyage API key (press enter to keep current)' : 'Voyage API key (embeddings)',
    mask: '•',
  })
  if (p.isCancel(voVal)) return cancel()
  if (typeof voVal === 'string' && voVal.length > 0) envUpsert(STACK_ENV, 'VOYAGE_API_KEY', voVal)

  // -- step 5: conditional block-owned secrets -----------------------------
  const enabled = new Set<string>([
    ...csv(envGet(STACK_ENV, 'COMPOSE_PROFILES')),
    ...csv(envGet(STACK_ENV, 'STACK_MACHINES')),
  ])

  if (enabled.has('litellm')) {
    if (genIfMissing('LITELLM_MASTER_KEY', 'sk-', 24)) p.log.success('generated LITELLM_MASTER_KEY')
  }
  if (enabled.has('agentmemory')) {
    if (genIfMissing('AGENTMEMORY_SECRET', '', 32)) p.log.success('generated AGENTMEMORY_SECRET')
  }
  if (enabled.has('cliproxyapi')) {
    if (genIfMissing('CLIPROXY_API_KEY', 'sk-', 24)) p.log.success('generated CLIPROXY_API_KEY')
    if (genIfMissing('CLIPROXY_MANAGEMENT_KEY', '', 32))
      p.log.success('generated CLIPROXY_MANAGEMENT_KEY')
  }
  if (enabled.has('hermes-workspace')) {
    if (genIfMissing('HERMES_WORKSPACE_PASSWORD', '', 32))
      p.log.success('generated HERMES_WORKSPACE_PASSWORD')
  }

  if (enabled.has('hermes')) {
    const group = await p.group(
      {
        botToken: () =>
          p.text({
            message: 'Telegram bot token (blank ok)',
            placeholder: envGet(STACK_ENV, 'HERMES_TELEGRAM_BOT_TOKEN') || '',
            defaultValue: envGet(STACK_ENV, 'HERMES_TELEGRAM_BOT_TOKEN') || '',
          }),
        allowedUsers: () =>
          p.text({
            message: 'Telegram allowed user IDs (blank ok)',
            placeholder: envGet(STACK_ENV, 'HERMES_TELEGRAM_ALLOWED_USERS') || '',
            defaultValue: envGet(STACK_ENV, 'HERMES_TELEGRAM_ALLOWED_USERS') || '',
          }),
        homeChannel: () =>
          p.text({
            message: 'Telegram home channel (blank ok)',
            placeholder: envGet(STACK_ENV, 'HERMES_TELEGRAM_HOME_CHANNEL') || '',
            defaultValue: envGet(STACK_ENV, 'HERMES_TELEGRAM_HOME_CHANNEL') || '',
          }),
      },
      {
        onCancel: () => {
          p.cancel('Setup cancelled.')
          process.exit(1)
        },
      },
    )
    if (group.botToken !== undefined) stackUpsert('HERMES_TELEGRAM_BOT_TOKEN', group.botToken)
    if (group.allowedUsers !== undefined)
      stackUpsert('HERMES_TELEGRAM_ALLOWED_USERS', group.allowedUsers)
    if (group.homeChannel !== undefined)
      stackUpsert('HERMES_TELEGRAM_HOME_CHANNEL', group.homeChannel)

    if (envGet(STACK_ENV, 'HERMES_GATEWAY_ALLOW_ACCESS') === 'true') {
      if (genIfMissing('HERMES_GATEWAY_API_KEY', '', 32)) {
        p.log.success('generated HERMES_GATEWAY_API_KEY (gate=open)')
      }
    }
  }

  chmodSync(STACK_ENV, 0o600)

  // -- summary -------------------------------------------------------------
  const profs = envGet(STACK_ENV, 'COMPOSE_PROFILES')
  const machs = envGet(STACK_ENV, 'STACK_MACHINES')
  p.note(
    [
      `Active docker services: ${pc.cyan(profs || '(none)')}`,
      `Active VM services:     ${pc.cyan(machs || '(none)')}`,
      `Env file:               ${pc.dim(STACK_ENV)}`,
    ].join('\n'),
    'summary',
  )

  p.outro(
    pc.green('Setup complete.') +
      ' Next: ./stack-cli build && ./stack-cli start (not yet ported — for now use `just build && just start`).',
  )
}

// ---- helpers ------------------------------------------------------------

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

const toOption = (s: ServiceDescriptor) => ({
  value: s.name,
  label: s.name,
  hint: s.desc,
})

const cancel = (): void => {
  p.cancel('Setup cancelled.')
  process.exit(1)
}
