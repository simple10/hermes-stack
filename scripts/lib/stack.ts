// stack.ts — block-aware reads/writes for .stack/.env.
//
// .stack/.env layout (mirrors .stack/.env in the bash system):
//
//   COMPOSE_PROJECT_NAME=…
//   OPENROUTER_API_KEY=…             ← top-level (no owner)
//
//   #>--- litellm ---                ← enabled service block
//   LITELLM_MASTER_KEY=…
//   #<--- litellm ---
//
//   # #>--- honcho ---               ← disabled (every line prefixed "# ")
//   # HONCHO_FOO=…
//   # #<--- honcho ---
//
// Block status:
//   enabled   - bare `#>--- svc ---` start marker
//   disabled  - `# #>--- svc ---` (one "# " prefix, preserves user edits)
//   missing   - no block at all
//
// stackUpsert routes block-owned keys into their block and dies if the
// block isn't enabled (caller must enable() first — matches the bash
// stack_upsert contract).
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { STACK_DIR, STACK_ENV } from './paths.ts'
import { envGet, envUpsert } from './env.ts'
import { stackEnvOwnerMap, loadService, serviceEnvSchema } from './services.ts'
import { die } from './log.ts'

export type BlockStatus = 'enabled' | 'disabled' | 'missing'

export const ensureStackDir = (): void => {
  if (!existsSync(STACK_DIR)) mkdirSync(STACK_DIR, { recursive: true })
}

export const owningService = (key: string): string | null => {
  return stackEnvOwnerMap().get(key) ?? null
}

export const blockStatus = (svc: string): BlockStatus => {
  if (!existsSync(STACK_ENV)) return 'missing'
  const body = readFileSync(STACK_ENV, 'utf8')
  const enabledRe = new RegExp(`^#>--- ${re(svc)} ---`, 'm')
  const disabledRe = new RegExp(`^# +#>--- ${re(svc)} ---`, 'm')
  if (enabledRe.test(body)) return 'enabled'
  if (disabledRe.test(body)) return 'disabled'
  return 'missing'
}

// Append a NEW enabled block at the end. Strips leading/trailing blank
// lines from `body` (the service.yaml `env:` literal block conventionally
// opens with a blank line for readability).
export const blockAppend = (svc: string, body: string): void => {
  ensureStackDir()
  const lines = body.split('\n')
  let i = 0,
    j = lines.length - 1
  while (i <= j && lines[i].trim() === '') i++
  while (j >= i && lines[j].trim() === '') j--
  const stripped = lines.slice(i, j + 1).join('\n')
  const prefix = existsSync(STACK_ENV) ? readFileSync(STACK_ENV, 'utf8') : ''
  const sep = prefix.length === 0 || prefix.endsWith('\n') ? '' : '\n'
  const next = prefix + sep + '\n#>--- ' + svc + ' ---\n' + stripped + '\n#<--- ' + svc + ' ---\n'
  writeFileSync(STACK_ENV, next)
  chmodSync(STACK_ENV, 0o600)
}

// Flip block in-place. Idempotent (no-op if already in target state).
export const blockToggle = (svc: string, target: 'enabled' | 'disabled'): void => {
  if (!existsSync(STACK_ENV)) return
  const startEn = new RegExp(`^#>--- ${re(svc)} ---`)
  const startDis = new RegExp(`^# +#>--- ${re(svc)} ---`)
  const endEn = new RegExp(`^#<--- ${re(svc)} ---`)
  const endDis = new RegExp(`^# +#<--- ${re(svc)} ---`)
  const lines = readFileSync(STACK_ENV, 'utf8').split('\n')
  const out: string[] = []
  let inBlock = false
  let state: BlockStatus = 'missing'
  for (const line of lines) {
    if (startEn.test(line)) {
      inBlock = true
      state = 'enabled'
    } else if (startDis.test(line)) {
      inBlock = true
      state = 'disabled'
    }
    let next = line
    if (inBlock) {
      if (target === 'disabled' && state === 'enabled') next = '# ' + line
      else if (target === 'enabled' && state === 'disabled') next = line.replace(/^# /, '')
    }
    out.push(next)
    if (endEn.test(line) || endDis.test(line)) {
      inBlock = false
      state = 'missing'
    }
  }
  writeFileSync(STACK_ENV, out.join('\n'))
  chmodSync(STACK_ENV, 0o600)
}

// Additive sync: for each KEY=... in schema, if KEY isn't already in the
// (enabled) block, append it just before the end marker. Preserves user
// values for existing keys.
export const blockSync = (svc: string, schema: string): void => {
  if (blockStatus(svc) !== 'enabled') return
  const startRe = new RegExp(`^#>--- ${re(svc)} ---`)
  const endRe = new RegExp(`^#<--- ${re(svc)} ---`)
  const lines = readFileSync(STACK_ENV, 'utf8').split('\n')
  let inBlock = false
  const present = new Set<string>()
  for (const line of lines) {
    if (startRe.test(line)) {
      inBlock = true
      continue
    }
    if (endRe.test(line)) {
      inBlock = false
      continue
    }
    if (inBlock) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
      if (m) present.add(m[1])
    }
  }
  const additions: string[] = []
  for (const raw of schema.split('\n')) {
    const t = raw.trim()
    if (!t || t.startsWith('#')) continue
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (!m) continue
    if (!present.has(m[1])) additions.push(raw)
  }
  if (additions.length === 0) return
  const out: string[] = []
  for (const line of lines) {
    if (endRe.test(line)) {
      for (const a of additions) out.push(a)
    }
    out.push(line)
  }
  writeFileSync(STACK_ENV, out.join('\n'))
  chmodSync(STACK_ENV, 0o600)
}

// stackGet — block-aware read. If KEY is owned by an enabled service's
// block, prefer the in-block value; otherwise fall back to a flat lookup.
export const stackGet = (key: string): string => {
  if (!existsSync(STACK_ENV)) return ''
  const owner = owningService(key)
  if (owner && blockStatus(owner) === 'enabled') {
    const body = readFileSync(STACK_ENV, 'utf8')
    const startRe = new RegExp(`^#>--- ${re(owner)} ---`)
    const endRe = new RegExp(`^#<--- ${re(owner)} ---`)
    let inBlock = false
    for (const line of body.split('\n')) {
      if (startRe.test(line)) {
        inBlock = true
        continue
      }
      if (endRe.test(line)) {
        inBlock = false
        continue
      }
      if (inBlock) {
        const m = line.match(new RegExp(`^${re(key)}=(.*)$`))
        if (m) return m[1]
      }
    }
  }
  return envGet(STACK_ENV, key)
}

// stackUpsert — block-aware write. Three cases:
//   (a) no owner -> top-level envUpsert
//   (b) owner + block ENABLED -> update line inside block, or insert
//       before the end marker. Removes any top-level orphan with the
//       same key (idempotent migration).
//   (c) owner + block disabled/missing -> die (caller must enable first).
export const stackUpsert = (key: string, value: string): void => {
  ensureStackDir()
  const owner = owningService(key)
  if (!owner) {
    envUpsert(STACK_ENV, key, value)
    return
  }
  const status = blockStatus(owner)
  if (status === 'disabled') {
    die(`stackUpsert: '${key}' is owned by '${owner}' but its block is DISABLED — enable it first`)
  }
  if (status === 'missing') {
    die(`stackUpsert: '${key}' is owned by '${owner}' but its block is MISSING — enable it first`)
  }
  const startRe = new RegExp(`^#>--- ${re(owner)} ---`)
  const endRe = new RegExp(`^#<--- ${re(owner)} ---`)
  const keyRe = new RegExp(`^${re(key)}=.*$`)
  const otherStartRe = /^#>--- /
  const otherEndRe = /^#<--- /
  const lines = readFileSync(STACK_ENV, 'utf8').split('\n')
  const out: string[] = []
  let inOwner = false
  let inAny = false
  let written = false
  for (const line of lines) {
    if (startRe.test(line)) {
      inOwner = true
      inAny = true
      out.push(line)
      continue
    }
    if (inOwner && endRe.test(line)) {
      if (!written) out.push(`${key}=${value}`)
      inOwner = false
      inAny = false
      written = true
      out.push(line)
      continue
    }
    if (otherStartRe.test(line)) {
      inAny = true
      out.push(line)
      continue
    }
    if (inAny && otherEndRe.test(line)) {
      inAny = false
      out.push(line)
      continue
    }
    if (inOwner && keyRe.test(line)) {
      out.push(`${key}=${value}`)
      written = true
      continue
    }
    if (!inAny && keyRe.test(line)) continue // drop top-level orphan
    out.push(line)
  }
  writeFileSync(STACK_ENV, out.join('\n'))
  chmodSync(STACK_ENV, 0o600)
}

export const csvAdd = (key: string, value: string): void => {
  const cur = stackGet(key)
  const parts = cur
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  if (parts.includes(value)) return
  parts.push(value)
  stackUpsert(key, parts.join(','))
}

export const csvRemove = (key: string, value: string): void => {
  const cur = stackGet(key)
  if (!cur) return
  const next = cur
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && x !== value)
  stackUpsert(key, next.join(','))
}

// --- enable / disable cascade ----------------------------------------

const isEnabled = (svc: string): boolean => {
  for (const k of ['COMPOSE_PROFILES', 'STACK_MACHINES'] as const) {
    const v = envGet(STACK_ENV, k)
    if (
      v &&
      v
        .split(',')
        .map((x) => x.trim())
        .includes(svc)
    )
      return true
  }
  return false
}

const enableOne = (svc: string): void => {
  const d = loadService(svc)
  if (!d) {
    die(`no such service: ${svc} (services/${svc}/service.yaml not found)`)
    return
  }
  const csvKey = d.runner === 'vm' ? 'STACK_MACHINES' : 'COMPOSE_PROFILES'
  csvAddTopLevel(csvKey, d.profile)
  if (d.litellmKey) csvAdd('LITELLM_VIRTKEYS', d.profile)
  // Schema = env: body + seeded version knobs (serviceEnvSchema), so digest-
  // pinned services surface an editable *_VERSION line and existing blocks
  // gain it via blockSync's additive merge.
  const schema = serviceEnvSchema(svc)
  const status = blockStatus(svc)
  if (status === 'disabled') blockToggle(svc, 'enabled')
  else if (status === 'missing' && schema) blockAppend(svc, schema)
  if (schema && blockStatus(svc) === 'enabled') blockSync(svc, schema)
}

// csv add for top-level keys (COMPOSE_PROFILES, STACK_MACHINES) — these
// MUST stay top-level even if a future refactor accidentally lists them
// in a service's env block. Bypass owner lookup.
const csvAddTopLevel = (key: string, value: string): void => {
  const cur = envGet(STACK_ENV, key)
  const parts = cur
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  if (parts.includes(value)) return
  parts.push(value)
  envUpsert(STACK_ENV, key, parts.join(','))
}

export const enableService = (svc: string, log?: (msg: string) => void): void => {
  const visited = new Set<string>()
  const visit = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    const d = loadService(name)
    if (!d) {
      die(`no such service: ${name}`)
      return // unreachable; TS narrowing aid
    }
    for (const r of d.requires) {
      if (!isEnabled(r) && log) log(`auto-enabling ${r} (required by ${name})`)
      visit(r)
    }
    enableOne(name)
  }
  visit(svc)
}

// Reverse of SERVICE_REQUIRES: which enabled services depend on `svc`?
// Used by disableService to refuse if anything would break.
export const findDependants = (svc: string): string[] => {
  const all = [
    ...envGet(STACK_ENV, 'COMPOSE_PROFILES')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    ...envGet(STACK_ENV, 'STACK_MACHINES')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  ]
  const out: string[] = []
  for (const dep of all) {
    if (dep === svc) continue
    const d = loadService(dep)
    if (!d) continue
    if (d.requires.includes(svc)) out.push(dep)
  }
  return out
}

// disableService — idempotent. Refuses (throws) if any enabled service
// has SERVICE_REQUIRES containing this one. No force flag.
export const disableService = (svc: string): { changed: boolean } => {
  const d = loadService(svc)
  if (!d) {
    die(`no such service: ${svc}`)
    throw new Error('unreachable')
  }
  const deps = findDependants(svc)
  if (deps.length > 0) {
    die(
      `refusing to disable '${svc}' — these enabled services depend on it: ${deps.join(', ')}\n` +
        `       disable them first:  stack-cli disable ${deps.join(' ')}`,
    )
    throw new Error('unreachable')
  }
  const before = existsSync(STACK_ENV) ? readFileSync(STACK_ENV, 'utf8') : ''
  const csvKey = d.runner === 'vm' ? 'STACK_MACHINES' : 'COMPOSE_PROFILES'
  csvRemoveTopLevel(csvKey, d.profile)
  if (d.litellmKey) csvRemove('LITELLM_VIRTKEYS', d.profile)
  if (blockStatus(svc) === 'enabled') blockToggle(svc, 'disabled')
  const after = existsSync(STACK_ENV) ? readFileSync(STACK_ENV, 'utf8') : ''
  return { changed: before !== after }
}

const csvRemoveTopLevel = (key: string, value: string): void => {
  const cur = envGet(STACK_ENV, key)
  if (!cur) return
  const next = cur
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && x !== value)
  envUpsert(STACK_ENV, key, next.join(','))
}

const re = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Re-exports for callers that need the raw helpers.
export { envGet, envUpsert }
export { isEnabled }
