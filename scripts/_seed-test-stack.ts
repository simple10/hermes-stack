// _seed-test-stack.ts — one-shot helper to bootstrap .stack-node/.env
// for the parallel test stack (project=hermes-node-test). Copies provider
// keys + Telegram values from the existing .stack/.env (read-only), sets
// up the right project name, and cascade-enables the target services.
//
// Run once via: bun run scripts/_seed-test-stack.ts
// Then: ./stack-cli build && ./stack-cli start
import { existsSync, copyFileSync, chmodSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { STACK_ROOT, STACK_DIR, STACK_ENV, DEFAULTS_ENV } from './lib/paths.ts'
import { envGet, envUpsert, parseEnvFile } from './lib/env.ts'
import { ensureStackDir, enableService, stackUpsert } from './lib/stack.ts'
import { genIfMissing } from './lib/secrets.ts'
import { renderCompose } from './lib/compose.ts'

const REAL_STACK_ENV = resolve(STACK_ROOT, '.stack', '.env')

// 1. Wipe + seed .stack-node from defaults.
if (existsSync(STACK_DIR)) rmSync(STACK_DIR, { recursive: true })
mkdirSync(STACK_DIR, { recursive: true })
ensureStackDir()
copyFileSync(DEFAULTS_ENV, STACK_ENV)
chmodSync(STACK_ENV, 0o600)

// 2. Project name + default CSVs cleared so cascade decides what's enabled.
envUpsert(STACK_ENV, 'COMPOSE_PROJECT_NAME', 'hermes-node-test')
envUpsert(STACK_ENV, 'COMPOSE_PROFILES', '')
envUpsert(STACK_ENV, 'STACK_MACHINES', '')

// 3. Copy provider keys + Telegram from the real .stack/.env (read-only).
const realKeys = existsSync(REAL_STACK_ENV) ? parseEnvFile(REAL_STACK_ENV) : {}
for (const k of ['OPENROUTER_API_KEY', 'VOYAGE_API_KEY']) {
  if (realKeys[k]) envUpsert(STACK_ENV, k, realKeys[k])
}

// 4. Cascade-enable target services.
const target = [
  'hermes', // VM; auto-pulls litellm -> pg, redis
  'honcho',
  'honcho-ui',
  'cliproxyapi',
  'searxng',
  'camofox-browser',
  'localhost-proxy',
]
const cascadeMsgs: string[] = []
for (const svc of target) enableService(svc, (m) => cascadeMsgs.push(m))
for (const m of cascadeMsgs) console.log('  ·', m)

// 5. Copy block-owned secrets from the real .stack/.env into the right blocks.
const blockKeys = [
  'HERMES_TELEGRAM_BOT_TOKEN',
  'HERMES_TELEGRAM_ALLOWED_USERS',
  'HERMES_TELEGRAM_HOME_CHANNEL',
]
for (const k of blockKeys) {
  const v = readFromBlock(REAL_STACK_ENV, k)
  if (v) stackUpsert(k, v)
}

// 6. Generate fresh secrets where missing.
genIfMissing('LITELLM_MASTER_KEY', 'sk-', 24)
genIfMissing('CLIPROXY_API_KEY', 'sk-', 24)
genIfMissing('CLIPROXY_MANAGEMENT_KEY', '', 32)

// 7. Override HERMES_MOUNT_DIR so the test stack uses its own .stack-node/
//    home, never .stack/hermes/.hermes (which is the running aitools stack).
stackUpsert('HERMES_MOUNT_DIR', '.stack-node/hermes/.hermes')

// 8. Render the compose file so dc() works.
renderCompose()

console.log('\nseed complete.')
console.log('  STACK_ENV:        ', STACK_ENV)
console.log('  COMPOSE_PROJECT:  ', envGet(STACK_ENV, 'COMPOSE_PROJECT_NAME'))
console.log('  COMPOSE_PROFILES: ', envGet(STACK_ENV, 'COMPOSE_PROFILES'))
console.log('  STACK_MACHINES:   ', envGet(STACK_ENV, 'STACK_MACHINES'))

// helper — read a KEY value from inside any #>--- svc --- block (or top-level).
function readFromBlock(file: string, key: string): string {
  if (!existsSync(file)) return ''
  const body = readFileSync(file, 'utf8')
  const m = body.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\\\\]]/g, '\\$&')}=(.*)$`, 'm'))
  return m ? m[1] : ''
}
