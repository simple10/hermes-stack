// endpoints.ts — build user-facing URLs from each service's `provides:` map.
//
// Host is deterministic from OrbStack DNS:
//   docker service -> <service>.<project>.orb.local
//   vm service     -> <project>-<svc>.orb.local        (orb machine DNS)
// where <service> defaults to the dir name (override via provides.<x>.service).
//
// Render rule (matches the repo's existing convention + how orb actually
// maps ports — TLS lives only on the bare domain, any explicit port is HTTP):
//   proto: https  OR  port 80/443  -> https://host[path]      (bare, no port)
//   datastore proto (postgres/…)   -> proto://host:port       (no scheme guess)
//   otherwise                      -> http://host:port[path]
import { stackProject, stackVmName } from './compose-env.ts'
import { loadService, type EndpointDecl } from './services.ts'
import { loadStackEnv } from './stack-env.ts'

export interface Cred {
  label: string // e.g. "user" / "pass" / "token"
  raw: string // literal (public) or "${VAR}" (secret)
}

export interface Endpoint {
  service: string // service dir, e.g. "honcho"
  name: string // endpoint key, e.g. "api" / "dashboard"
  url: string
  dnsName: string // orb DNS name (compose service, or vm name) — for run-state match
  isVm: boolean
  auth: Cred[] // ordered credential hints (empty if none declared)
}

// A credential value is "secret" iff it's a ${VAR} / $VAR reference. Literals
// (user: admin) are public and always shown.
const SECRET_REF = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/
export const isSecretRef = (raw: string): boolean => SECRET_REF.test(raw)

let _env: Record<string, string> | null = null

// Resolve a cred for display. Literals pass through. Secret refs render as the
// bare $VAR name unless `reveal` — then the value from .stack/.env (+ generated
// overlays) is substituted (or "(unset: $VAR)" when missing/empty).
export const resolveCred = (raw: string, reveal: boolean): { value: string; secret: boolean } => {
  const m = raw.match(SECRET_REF)
  if (!m) return { value: raw, secret: false }
  const name = m[1]
  if (!reveal) return { value: `$${name}`, secret: true }
  _env ??= loadStackEnv()
  const v = _env[name]
  return { value: v && v.length > 0 ? v : `(unset: $${name})`, secret: true }
}

const DATASTORE = new Set(['postgres', 'postgresql', 'redis', 'amqp', 'amqps'])

const buildUrl = (host: string, ep: EndpointDecl): string => {
  const path = ep.path ?? ''
  if (ep.proto === 'https' || ep.port === 80 || ep.port === 443) return `https://${host}${path}`
  if (ep.proto && DATASTORE.has(ep.proto)) return `${ep.proto}://${host}:${ep.port}`
  return `http://${host}:${ep.port}${path}`
}

// Endpoints declared by a single service (empty if it has no `provides:`).
export const serviceEndpoints = (svc: string): Endpoint[] => {
  const d = loadService(svc)
  if (!d) return []
  const project = stackProject()
  const out: Endpoint[] = []
  for (const [name, ep] of Object.entries(d.provides)) {
    if (!Number.isFinite(ep.port)) continue
    const isVm = d.runner === 'vm'
    const dnsName = isVm ? stackVmName(svc) : (ep.service ?? svc)
    const host = isVm ? `${dnsName}.orb.local` : `${dnsName}.${project}.orb.local`
    const auth: Cred[] = ep.auth
      ? Object.entries(ep.auth).map(([label, raw]) => ({ label, raw }))
      : []
    out.push({ service: svc, name, url: buildUrl(host, ep), dnsName, isVm, auth })
  }
  return out
}
