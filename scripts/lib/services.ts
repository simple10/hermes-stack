// services.ts — discover service descriptors from services/*/service.env.
//
// Each service.env is parsed by dotenv (lib/env.ts), which handles
// quoting, inline `# comment` stripping, and (importantly here)
// multi-line single-quoted values like:
//
//   SERVICE_STACK_ENV='
//   FOO=bar
//   BAZ=${SOME_REF}
//   '
//
// Recognized declarations (all optional unless noted):
//   SERVICE_RUNNER=docker|vm        (default docker)
//   SERVICE_PROFILE=<name>          (default = dir name)
//   SERVICE_KIND=backend            (substrate; hidden from setup list)
//   SERVICE_DESC="…"
//   SERVICE_REQUIRES=a,b,c          (CSV, transitive)
//   SERVICE_LITELLM_KEY=true|false
//   SERVICE_STACK_ENV='multi-line'  (body injected as #>--- svc --- block)
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { SERVICES_DIR } from './paths.ts'
import { parseEnvFile, parseEnvBody } from './env.ts'

export interface ServiceDescriptor {
  name: string
  runner: 'docker' | 'vm'
  profile: string
  kind: string // "backend" | "" (others reserved)
  desc: string
  requires: string[]
  litellmKey: boolean
  stackEnv: string // multi-line body (no enclosing quotes)
}

const cache = new Map<string, ServiceDescriptor>()

export const loadService = (name: string): ServiceDescriptor | null => {
  if (cache.has(name)) return cache.get(name)!
  const f = resolve(SERVICES_DIR, name, 'service.env')
  if (!existsSync(f)) return null
  const flat = parseEnvFile(f)
  const runnerStr = (flat.SERVICE_RUNNER ?? 'docker').toLowerCase()
  const runner: 'docker' | 'vm' = runnerStr === 'vm' ? 'vm' : 'docker'
  const desc = flat.SERVICE_DESC ?? ''
  const requires = csv(flat.SERVICE_REQUIRES ?? '')
  const profile = flat.SERVICE_PROFILE || name
  const litellmKey = (flat.SERVICE_LITELLM_KEY ?? '').toLowerCase() === 'true'
  const kind = (flat.SERVICE_KIND ?? '').toLowerCase()
  const stackEnv = flat.SERVICE_STACK_ENV ?? ''
  const d: ServiceDescriptor = { name, runner, profile, kind, desc, requires, litellmKey, stackEnv }
  cache.set(name, d)
  return d
}

export const listServices = (): ServiceDescriptor[] => {
  const out: ServiceDescriptor[] = []
  for (const entry of readdirSync(SERVICES_DIR)) {
    const dir = resolve(SERVICES_DIR, entry)
    if (!statSync(dir).isDirectory()) continue
    const d = loadService(entry)
    if (d) out.push(d)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// Map of every KEY -> owning service, by parsing each service's
// SERVICE_STACK_ENV body. Cached after first call.
let _ownerCache: Map<string, string> | null = null
export const stackEnvOwnerMap = (): Map<string, string> => {
  if (_ownerCache) return _ownerCache
  const out = new Map<string, string>()
  for (const svc of listServices()) {
    if (!svc.stackEnv) continue
    const parsed = parseEnvBody(svc.stackEnv)
    for (const k of Object.keys(parsed)) out.set(k, svc.name)
  }
  _ownerCache = out
  return out
}

// Drop the descriptor + owner caches. Tests use this between runs.
export const _resetServiceCache = (): void => {
  cache.clear()
  _ownerCache = null
}

// Transitive SERVICE_REQUIRES closure. Cycle-safe (visited set). Returns
// leaf-first order so callers can enable dependencies before consumers.
export const expandRequires = (seed: readonly string[]): string[] => {
  const visited = new Set<string>()
  const order: string[] = []
  const visit = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    const d = loadService(name)
    if (!d) return
    for (const r of d.requires) visit(r)
    order.push(name)
  }
  for (const s of seed) visit(s)
  return order
}

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
