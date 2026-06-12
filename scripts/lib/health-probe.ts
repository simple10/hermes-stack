// health-probe.ts — out-of-band, stack-authoritative health probing.
//
// The stack runs its OWN probe of a service's declared endpoint (orb DNS),
// independent of the in-container healthcheck — so a probe broken by an image
// base change (cliproxy lost wget; phoenix lost /bin/sh) never masks a working
// service. Drives `info`/`start` display and the `update` health-gate.
//
// Probe spec comes from service.yaml `health:` + `provides:`:
//   health.path set            -> HTTP GET <orb-url><path>, ok = expect|2xx-3xx
//   health.tcp / no path / DB  -> TCP connect to the port
import net from 'node:net'
import { stackProject, stackVmName } from './compose-env.ts'
import { loadService } from './services.ts'
import type { StackHealth } from './health.ts'

export type HealthProbe =
  | { kind: 'http'; url: string; expect: number | null }
  | { kind: 'tcp'; host: string; port: number }
  | null

// Resolve the out-of-band probe for a service from its health:/provides: decls.
// Returns null when there is no probe-able endpoint.
export const healthProbeSpec = (svc: string): HealthProbe => {
  const d = loadService(svc)
  if (!d) return null
  const entries = Object.entries(d.provides)
  const primary = entries[0]?.[1]
  const h = d.health
  const port = h?.port ?? (primary && Number.isFinite(primary.port) ? primary.port : undefined)
  if (!port) return null
  const isVm = d.runner === 'vm'
  const dnsName = isVm ? stackVmName(svc) : (primary?.service ?? svc)
  const host = isVm ? `${dnsName}.orb.local` : `${dnsName}.${stackProject()}.orb.local`
  if (h?.path)
    return { kind: 'http', url: `http://${host}:${port}${h.path}`, expect: h.expect ?? null }
  return { kind: 'tcp', host, port }
}

// Run a probe once. Never throws — returns false on any failure/timeout.
export const probeOnce = async (p: HealthProbe, timeoutMs = 2500): Promise<boolean> => {
  if (!p) return false
  if (p.kind === 'http') {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await fetch(p.url, { signal: ac.signal, redirect: 'manual' })
      if (p.expect != null) return r.status === p.expect
      return r.status >= 200 && r.status < 400
    } catch {
      return false
    } finally {
      clearTimeout(t)
    }
  }
  return await new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: p.host, port: p.port })
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

// Enrich a StackHealth snapshot in place with out-of-band reachability for each
// running service that has a probe-able endpoint. Best-effort, parallel, short
// timeout — never blocks info on a hung service for long.
export const enrichReachability = async (h: StackHealth, timeoutMs = 2500): Promise<void> => {
  await Promise.all(
    h.services.map(async (s) => {
      if (s.run !== 'running') return
      const spec = healthProbeSpec(s.service)
      if (!spec) return
      s.reachable = await probeOnce(spec, timeoutMs)
    }),
  )
}
