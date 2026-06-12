// render-health.ts — service / VM line formatters used by `info`.
//
// ANSI-stripped width for measurement so picocolors markup doesn't
// throw off column calc. For very narrow terminals the service column
// collapses to whatever fits.
import pc from 'picocolors'
import type { HealthState, RunState, ServiceHealth, MachineHealth } from './health.ts'
import { resolveCred, type Endpoint } from './endpoints.ts'

const ICON_OK = pc.green('●')
const ICON_WARN = pc.yellow('●')
const ICON_BAD = pc.red('✕')
const ICON_DIM = pc.dim('○')

export const stateIcon = (run: RunState, health: HealthState): string => {
  if (run !== 'running') return ICON_DIM
  if (health === 'unhealthy') return ICON_BAD
  if (health === 'starting') return ICON_WARN
  return ICON_OK
}

export const machineIcon = (run: MachineHealth['run']): string => {
  if (run === 'running') return ICON_OK
  if (run === 'stopped') return ICON_DIM
  return ICON_BAD
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const visibleLen = (s: string): number => stripAnsi(s).length

const pad = (s: string, n: number): string => {
  const w = visibleLen(s)
  return w >= n ? s : s + ' '.repeat(n - w)
}

const stateBadge = (run: RunState, health: HealthState): string => {
  const runWord =
    run === 'running'
      ? pc.green('running')
      : run === 'exited'
        ? pc.dim('exited')
        : run === 'missing'
          ? pc.dim('missing')
          : run === 'restarting'
            ? pc.yellow('restarting')
            : pc.dim(run)
  if (run !== 'running') return runWord
  const h =
    health === 'healthy'
      ? pc.green('healthy')
      : health === 'unhealthy'
        ? pc.red('unhealthy')
        : health === 'starting'
          ? pc.yellow('starting')
          : ''
  return h ? `${runWord}, ${h}` : runWord
}

export const formatServiceLines = (services: ServiceHealth[]): string[] => {
  if (services.length === 0) return [pc.dim('  (no services)')]
  const w = services.reduce((m, s) => Math.max(m, s.service.length), 0)
  return services.map((s) => {
    const icon = stateIcon(s.run, s.health)
    const name = pad(s.service, w)
    const badge = stateBadge(s.run, s.health)
    const ver = s.version ? pc.cyan(`  ${s.version}`) : ''
    const extra = s.containerName ? pc.dim(`  ${s.containerName}`) : ''
    return `${icon}  ${name}  ${badge}${ver}${extra}`
  })
}

export interface EndpointGroup {
  service: string
  rows: { ep: Endpoint; up: boolean }[]
}

// Grouped, dim-when-down endpoint URLs for the `info` Endpoints section.
// Declared credentials render under each URL: literals shown plainly, secret
// ${VAR} refs masked to $VAR unless `showSecrets` resolves them.
export const formatEndpointLines = (groups: EndpointGroup[], showSecrets = false): string[] => {
  if (groups.length === 0) return [pc.dim('  (no endpoints)')]
  const labelW = groups.reduce(
    (m, g) => g.rows.reduce((mm, r) => Math.max(mm, r.ep.name.length), m),
    0,
  )
  const indent = ' '.repeat(labelW + 4) // align cred lines under the URL column
  const out: string[] = []
  for (const g of groups) {
    out.push(pc.cyan(g.service))
    for (const { ep, up } of g.rows) {
      const label = pc.dim(pad(ep.name, labelW))
      out.push(`  ${label}  ${up ? pc.yellow(ep.url) : pc.dim(ep.url)}`)
      for (const cred of ep.auth) {
        const { value } = resolveCred(cred.raw, showSecrets)
        out.push(`${indent}${pc.gray(cred.label + ':')} ${pc.gray(value)}`)
      }
    }
  }
  return out
}

export const formatMachineLines = (machines: MachineHealth[]): string[] => {
  if (machines.length === 0) return [pc.dim('  (no VMs configured)')]
  const w = machines.reduce((m, x) => Math.max(m, x.service.length), 0)
  return machines.map((m) => {
    const icon = machineIcon(m.run)
    const name = pad(m.service, w)
    const state =
      m.run === 'running'
        ? pc.green('running')
        : m.run === 'stopped'
          ? pc.dim('stopped')
          : pc.red('missing')
    return `${icon}  ${name}  ${state}  ${pc.dim(`(${m.vm})`)}`
  })
}
