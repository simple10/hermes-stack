// services.ts — discover service descriptors from services/*/service.yaml.
//
// Each service.yaml is parsed by the `yaml` lib. The injected env block is a
// LITERAL block scalar (`env: |`), so its contents — including comments and
// `${VAR}` refs — are preserved verbatim and re-parsed by dotenv (lib/env.ts)
// exactly as the old SERVICE_STACK_ENV value was. The literal block also
// kills the apostrophe-escaping bug class the single-quoted .env value had.
//
// Schema (all optional unless noted):
//   runner: docker|vm                 (default docker)
//   kind: backend                     (substrate; hidden from setup list)
//   desc: "…"
//   requires: [a, b, c]               (transitive, leaf-first via expandRequires)
//   litellmKey: true|false            (default false)
//   provides:                         (endpoint map -> info / start URLs)
//     <name>: { port, path?, proto?, service? }
//       port    container port (orb DNS uses this)
//       path    URL path suffix (default "")
//       proto   http(default) | https | postgres | redis | amqp | …
//               https forces the bare auto-HTTPS domain (drops the port)
//       service compose-service / orb DNS name (default = dir name)
//   source: { repo, default }         (source-class build metadata)
//   images:                           (digest-class build metadata)
//     <NAME>: { repo, default }       (<NAME> = the *_VERSION knob prefix)
//   env: |                            (multi-line body injected as #>--- svc --- block)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as yamlParse } from 'yaml'
import { SERVICES_DIR } from './paths.ts'
import { parseEnvBody } from './env.ts'

export interface EndpointDecl {
  port: number
  path?: string
  proto?: string
  service?: string // orb DNS name (compose service); default = dir name
  // Ordered credential hints rendered under the URL by `info`. Values are
  // either literals (public, e.g. user: admin) or ${VAR} refs (secret —
  // masked to the bare $VAR name unless `info --show-pass` resolves them).
  auth?: Record<string, string>
}

export interface ImageDecl {
  repo: string
  default: string
}

export interface SourceDecl {
  repo: string
  default: string
}

// Out-of-band health probe spec. `path` => HTTP GET on the provides endpoint
// (success = `expect` or any 2xx/3xx); `tcp` or no path => TCP connect. `port`
// defaults to the primary provides port.
export interface HealthDecl {
  path?: string
  port?: number
  expect?: number
  tcp?: boolean
}

export interface ServiceDescriptor {
  name: string
  runner: 'docker' | 'vm'
  profile: string
  kind: string // "backend" | "" (others reserved)
  desc: string
  requires: string[]
  litellmKey: boolean
  provides: Record<string, EndpointDecl>
  source: SourceDecl | null
  images: Record<string, ImageDecl>
  health: HealthDecl | null
  env: string // multi-line body (no enclosing quotes)
}

const cache = new Map<string, ServiceDescriptor>()

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []

export const loadService = (name: string): ServiceDescriptor | null => {
  if (cache.has(name)) return cache.get(name)!
  const f = resolve(SERVICES_DIR, name, 'service.yaml')
  if (!existsSync(f)) return null
  let raw: Record<string, unknown>
  try {
    raw = (yamlParse(readFileSync(f, 'utf8')) ?? {}) as Record<string, unknown>
  } catch (e) {
    throw new Error(`services/${name}/service.yaml: invalid YAML — ${(e as Error).message}`)
  }
  const runnerStr = String(raw.runner ?? 'docker').toLowerCase()
  const runner: 'docker' | 'vm' = runnerStr === 'vm' ? 'vm' : 'docker'
  const provides: Record<string, EndpointDecl> = {}
  if (raw.provides && typeof raw.provides === 'object') {
    for (const [k, v] of Object.entries(raw.provides as Record<string, unknown>)) {
      const ep = (v ?? {}) as Record<string, unknown>
      let auth: Record<string, string> | undefined
      if (ep.auth && typeof ep.auth === 'object') {
        auth = {}
        for (const [ak, av] of Object.entries(ep.auth as Record<string, unknown>))
          auth[ak] = String(av)
      }
      provides[k] = {
        port: Number(ep.port),
        path: ep.path != null ? String(ep.path) : undefined,
        proto: ep.proto != null ? String(ep.proto).toLowerCase() : undefined,
        service: ep.service != null ? String(ep.service) : undefined,
        auth,
      }
    }
  }
  const images: Record<string, ImageDecl> = {}
  if (raw.images && typeof raw.images === 'object') {
    for (const [k, v] of Object.entries(raw.images as Record<string, unknown>)) {
      const im = (v ?? {}) as Record<string, unknown>
      images[k] = { repo: String(im.repo ?? ''), default: String(im.default ?? '') }
    }
  }
  let source: SourceDecl | null = null
  if (raw.source && typeof raw.source === 'object') {
    const s = raw.source as Record<string, unknown>
    source = { repo: String(s.repo ?? ''), default: String(s.default ?? '') }
  }
  let health: HealthDecl | null = null
  if (raw.health && typeof raw.health === 'object') {
    const hh = raw.health as Record<string, unknown>
    health = {
      path: hh.path != null ? String(hh.path) : undefined,
      port: hh.port != null ? Number(hh.port) : undefined,
      expect: hh.expect != null ? Number(hh.expect) : undefined,
      tcp: hh.tcp === true,
    }
  }
  const d: ServiceDescriptor = {
    name,
    runner,
    profile: String(raw.profile ?? name),
    kind: String(raw.kind ?? '').toLowerCase(),
    desc: String(raw.desc ?? ''),
    requires: asArray(raw.requires),
    litellmKey: raw.litellmKey === true,
    provides,
    source,
    images,
    health,
    env: typeof raw.env === 'string' ? raw.env : '',
  }
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

const svcUc = (svc: string): string => svc.toUpperCase().replace(/-/g, '_')

export interface VersionKnob {
  key: string // the *_VERSION env knob (e.g. PHOENIX_VERSION, FIRECRAWL_API_VERSION)
  default: string // images.default or source.default
  repo: string // upstream repo for discovery
  kind: 'image' | 'source'
  imageName?: string // the images: map key (image kind only)
}

// The version knob(s) a service exposes, derived from its images:/source:
// blocks. Single source of truth for seeding, display, and update. The knob
// name mirrors the build resolvers: images use `<NAME>_VERSION` (images.ts),
// source uses `<SVC_UC>_VERSION` (source.ts).
export const serviceVersionKnobs = (svc: string): VersionKnob[] => {
  const d = loadService(svc)
  if (!d) return []
  const out: VersionKnob[] = []
  for (const [name, im] of Object.entries(d.images)) {
    out.push({
      key: `${name}_VERSION`,
      default: im.default,
      repo: im.repo,
      kind: 'image',
      imageName: name,
    })
  }
  if (d.source) {
    out.push({
      key: `${svcUc(svc)}_VERSION`,
      default: d.source.default,
      repo: d.source.repo,
      kind: 'source',
    })
  }
  return out
}

// Plain-tag services pin their version in the compose `image: repo:${X_VERSION}`
// line (knob in env:, no images:/source: block). serviceTagKnobs recovers the
// repo + knob from compose so `update` can discover them too. Returns [] for
// digest-pinned (`image: ${X_IMAGE}`) or source-built services.
export const serviceTagKnobs = (svc: string): VersionKnob[] => {
  const f = resolve(SERVICES_DIR, svc, 'compose.yaml')
  if (!existsSync(f)) return []
  let doc: { services?: Record<string, { image?: unknown }> }
  try {
    doc = (yamlParse(readFileSync(f, 'utf8')) ?? {}) as typeof doc
  } catch {
    return []
  }
  const out: VersionKnob[] = []
  const seen = new Set<string>()
  for (const s of Object.values(doc.services ?? {})) {
    const img = s?.image
    if (typeof img !== 'string') continue
    // repo:${X_VERSION} or repo:${X_VERSION:-default}
    const m = img.match(/^([^:${}]+):\$\{([A-Za-z_][A-Za-z0-9_]*_VERSION)(?::-[^}]*)?\}$/)
    if (!m || seen.has(m[2])) continue
    // Skip a knob owned by ANOTHER service — provisioner one-shots reference a
    // sibling's image (e.g. *-provision uses pgvector:${PG_VERSION}); that knob
    // belongs to pg, not this service.
    const owner = stackEnvOwnerMap().get(m[2])
    if (owner && owner !== svc) continue
    seen.add(m[2])
    out.push({ key: m[2], default: '', repo: m[1], kind: 'image', imageName: undefined })
  }
  return out
}

// The full .stack/.env block schema for a service: its env: body plus a seeded
// `<KEY>=<default>` line for every version knob the maintainer did NOT already
// hand-declare in env:. blockSync/blockAppend consume this so every versioned
// service surfaces an editable knob; additive semantics make it idempotent.
export const serviceEnvSchema = (svc: string): string => {
  const d = loadService(svc)
  if (!d) return ''
  const knobs = serviceVersionKnobs(svc)
  if (knobs.length === 0) return d.env
  const present = new Set(Object.keys(parseEnvBody(d.env)))
  const missing = knobs.filter((k) => !present.has(k.key))
  if (missing.length === 0) return d.env
  const base = d.env.replace(/\n*$/, '')
  const seeded = [
    '# image/source version knob — bump then `stack-cli build && stack-cli restart`',
    ...missing.map((k) => `${k.key}=${k.default}`),
  ].join('\n')
  return (base ? base + '\n' : '') + seeded + '\n'
}

// Map of every KEY -> owning service: each service's env: block keys PLUS its
// derived version knobs (so digest-pinned services whose knob is not hand-
// declared in env: still resolve as block-owned). Cached after first call.
let _ownerCache: Map<string, string> | null = null
export const stackEnvOwnerMap = (): Map<string, string> => {
  if (_ownerCache) return _ownerCache
  const out = new Map<string, string>()
  for (const svc of listServices()) {
    if (svc.env) {
      const parsed = parseEnvBody(svc.env)
      for (const k of Object.keys(parsed)) out.set(k, svc.name)
    }
    for (const knob of serviceVersionKnobs(svc.name)) {
      if (!out.has(knob.key)) out.set(knob.key, svc.name)
    }
  }
  _ownerCache = out
  return out
}

// Drop the descriptor + owner caches. Tests use this between runs.
export const _resetServiceCache = (): void => {
  cache.clear()
  _ownerCache = null
}

// Transitive requires closure. Cycle-safe (visited set). Returns leaf-first
// order so callers can enable dependencies before consumers.
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
