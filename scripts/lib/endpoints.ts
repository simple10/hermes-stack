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

export interface Endpoint {
  service: string // service dir, e.g. "honcho"
  name: string // endpoint key, e.g. "api" / "dashboard"
  url: string
  dnsName: string // orb DNS name (compose service, or vm name) — for run-state match
  isVm: boolean
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
    out.push({ service: svc, name, url: buildUrl(host, ep), dnsName, isVm })
  }
  return out
}
