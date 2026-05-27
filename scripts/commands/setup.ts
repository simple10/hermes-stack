// commands/setup.ts — interactive setup flow (clack-driven).
//
// Step order:
//   1. Seed .stack/.env from .stack.defaults.env (first run = copy;
//      subsequent = additive merge of missing keys).
//   2. Prompt for COMPOSE_PROJECT_NAME.
//   3. Multi-select docker + VM services (cascade SERVICE_REQUIRES).
//   4. Hermes memory backend (only if hermes is enabled). Optionally
//      cascade-enable the chosen backend's service.
//   5. Stack-wide LLM model levers (primary chat, fast/background,
//      embedding). Examples for cliproxy / openrouter / openai / anthropic.
//   6. Provider API keys — ONLY for the providers actually referenced by
//      the chosen models. cliproxy users get an OAuth-setup note instead.
//   7. Block-owned secret generation (litellm/agentmemory/cliproxy/etc).
//   8. Hermes Telegram fields (if hermes enabled).
//   9. Summary + next steps.
import { existsSync, copyFileSync, chmodSync } from 'node:fs'
import * as p from '@clack/prompts'
import pc from 'picocolors'

import { STACK_ENV, DEFAULTS_ENV } from '../lib/paths.ts'
import { envGet, envUpsert, parseEnvFile } from '../lib/env.ts'
import { ensureStackDir, enableService, stackGet, stackUpsert } from '../lib/stack.ts'
import { listServices, type ServiceDescriptor } from '../lib/services.ts'
import { genIfMissing } from '../lib/secrets.ts'

type MemoryBackend = 'honcho' | 'hindsight' | 'agentmemory' | 'holographic' | 'default'

const MEMORY_BACKING_SERVICE: Record<MemoryBackend, string | null> = {
  honcho: 'honcho',
  hindsight: 'hindsight',
  agentmemory: 'agentmemory',
  holographic: null, // fully local in the VM
  default: null, // use hermes' own default; no override
}

export const runSetup = async (): Promise<void> => {
  p.intro(pc.bgCyan(pc.black(' hermes-stack setup ')))
  ensureStackDir()

  // -- step 1: seed .stack/.env from defaults --------------------------
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

  // -- step 4: hermes memory backend (only if hermes is enabled) -----------
  const manualMemoryNotice: string[] = []
  if ((vmPick as string[]).includes('hermes')) {
    const curMem = (stackGet('HERMES_MEMORY') || 'honcho') as MemoryBackend
    const mem = (await p.select<MemoryBackend>({
      message:
        'Hermes memory backend\n' + pc.dim('  determines what Hermes uses for long-term recall'),
      options: [
        { value: 'honcho', label: 'honcho', hint: 'graph-based; recommended' },
        { value: 'hindsight', label: 'hindsight', hint: 'vector + reranker' },
        { value: 'agentmemory', label: 'agentmemory', hint: 'fast file-based via MCP shim' },
        { value: 'holographic', label: 'holographic', hint: 'fully local in the VM (no service)' },
        { value: 'default', label: 'default', hint: "leave hermes' built-in unchanged" },
      ],
      initialValue: curMem,
    })) as MemoryBackend | symbol
    if (p.isCancel(mem)) return cancel()
    stackUpsert('HERMES_MEMORY', mem as string)

    // Cascade-enable backing service if it's not already in COMPOSE_PROFILES.
    const backing = MEMORY_BACKING_SERVICE[mem as MemoryBackend]
    if (backing) {
      const enabledNow = new Set(csv(envGet(STACK_ENV, 'COMPOSE_PROFILES')))
      if (!enabledNow.has(backing)) {
        const enableIt = await p.confirm({
          message: `Enable the local '${backing}' service in this stack?`,
          initialValue: true,
        })
        if (p.isCancel(enableIt)) return cancel()
        if (enableIt) {
          const msgs: string[] = []
          enableService(backing, (m) => msgs.push(m))
          for (const m of msgs) p.log.info(m)
        } else {
          manualMemoryNotice.push(
            `hermes will use '${backing}' but the local service isn't enabled — after start, ` +
              `point hermes at an external ${backing} endpoint (edit ~/.hermes/config.yaml ` +
              `via the mount at .stack/hermes/.hermes/, or run 'hermes config set' in the VM).`,
          )
        }
      }
    }
  }

  // -- step 5: stack-wide LLM models ---------------------------------------
  p.note(
    [
      'These three values feed every per-service *_MODEL lever in .stack/.env',
      'and (via LiteLLM) every chat/embedding call the stack makes.',
      '',
      pc.bold('Examples:'),
      '  cliproxy/gpt-5.5                  ' + pc.dim('ChatGPT-sub via CLIProxyAPI'),
      '  cliproxy/claude-sonnet-4.5        ' + pc.dim('Claude Code sub via CLIProxyAPI'),
      '  openrouter/anthropic/claude-sonnet-4.5  ' + pc.dim('OpenRouter pay-per-token'),
      '  openrouter/openai/gpt-5           ' + pc.dim('OpenRouter pay-per-token'),
      '  openai/gpt-5                      ' + pc.dim('direct OpenAI'),
      '  anthropic/claude-sonnet-4.5       ' + pc.dim('direct Anthropic'),
      '',
      pc.bold('Embeddings:'),
      '  voyage-4-lite                     ' + pc.dim('default; Voyage AI'),
      '  voyage-4                          ' + pc.dim('higher quality'),
      '  openai/text-embedding-3-large     ' + pc.dim('direct OpenAI'),
    ].join('\n'),
    'Stack-wide LLM models',
  )

  const askModel = async (key: string, label: string, fallback: string): Promise<string> => {
    const cur = envGet(STACK_ENV, key) || fallback
    const v = await p.text({
      message: label,
      placeholder: cur,
      defaultValue: cur,
    })
    if (p.isCancel(v)) {
      cancel()
      throw new Error('unreachable')
    }
    return (v as string).trim() || cur
  }

  const primary = await askModel('STACK_LLM_MODEL', 'Primary chat model', 'cliproxy/gpt-5.5')
  const fast = await askModel(
    'STACK_LLM_MODEL_FAST',
    'Fast / background model',
    'cliproxy/gpt-5.4-mini',
  )
  const embedding = await askModel('STACK_LLM_EMBEDDING_MODEL', 'Embedding model', 'voyage-4-lite')
  envUpsert(STACK_ENV, 'STACK_LLM_MODEL', primary)
  envUpsert(STACK_ENV, 'STACK_LLM_MODEL_FAST', fast)
  envUpsert(STACK_ENV, 'STACK_LLM_EMBEDDING_MODEL', embedding)

  // -- step 6: provider API keys, conditional on chosen models -------------
  const models = [primary, fast, embedding]
  const usesProvider = (prefix: string): boolean =>
    models.some((m) => m.toLowerCase().startsWith(prefix))
  const usesVoyage = models.some((m) => /^voyage/i.test(m))

  const askSecret = async (key: string, message: string): Promise<void> => {
    const cur = envGet(STACK_ENV, key)
    const v = await p.password({
      message: cur ? `${message} ${pc.dim('(enter to keep current)')}` : message,
      mask: '•',
    })
    if (p.isCancel(v)) {
      cancel()
      return
    }
    if (typeof v === 'string' && v.length > 0) envUpsert(STACK_ENV, key, v)
  }

  if (usesProvider('openrouter/')) {
    p.log.step('OpenRouter API key needed for openrouter/* models')
    await askSecret('OPENROUTER_API_KEY', 'OpenRouter API key')
  }
  if (usesVoyage) {
    p.log.step('Voyage API key needed for voyage embeddings')
    await askSecret('VOYAGE_API_KEY', 'Voyage API key')
  }
  if (usesProvider('openai/')) {
    p.log.step('OpenAI API key needed for openai/* models')
    await askSecret('OPENAI_API_KEY', 'OpenAI API key')
  }
  if (usesProvider('anthropic/')) {
    p.log.step('Anthropic API key needed for anthropic/* models')
    await askSecret('ANTHROPIC_API_KEY', 'Anthropic API key')
  }
  const usesCliproxy = usesProvider('cliproxy/')
  const projectName = envGet(STACK_ENV, 'COMPOSE_PROJECT_NAME') || 'aitools'
  if (usesCliproxy) {
    p.note(
      [
        'cliproxy/* models route through CLIProxyAPI, which uses OAuth subscriptions',
        '(ChatGPT, Claude Code, Codex, Gemini CLI) — no API key required up front.',
        '',
        pc.bold('After ./stack-cli start, activate each provider:'),
        `  1. Open  http://cliproxyapi.${projectName}.orb.local:8317/management.html`,
        '  2. Sign in with the CLIPROXY_MANAGEMENT_KEY from .stack/.env',
        '  3. For each provider you want to use, click its OAuth button and complete',
        '     the flow. When the provider redirects to a localhost URL that fails,',
        '     copy the failed URL from the address bar and paste it into the',
        "     panel's callback field — that completes the token exchange.",
      ].join('\n'),
      'cliproxy OAuth setup',
    )
  }

  // -- step 7: block-owned secret generation -------------------------------
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

  // -- step 8: hermes Telegram -------------------------------------------
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

  // Surface any deferred manual-config notices.
  for (const msg of manualMemoryNotice) p.log.warn(msg)

  chmodSync(STACK_ENV, 0o600)

  // -- summary -------------------------------------------------------------
  const profs = envGet(STACK_ENV, 'COMPOSE_PROFILES')
  const machs = envGet(STACK_ENV, 'STACK_MACHINES')
  p.note(
    [
      `Active docker services: ${pc.cyan(profs || '(none)')}`,
      `Active VM services:     ${pc.cyan(machs || '(none)')}`,
      `Primary model:          ${pc.cyan(primary)}`,
      `Fast model:             ${pc.cyan(fast)}`,
      `Embedding model:        ${pc.cyan(embedding)}`,
      `Env file:               ${pc.dim(STACK_ENV)}`,
    ].join('\n'),
    'summary',
  )

  p.outro(pc.green('Setup complete.') + ' Next: ./stack-cli build && ./stack-cli start')
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
