// commands/info.ts — friendly overview: what's enabled, what's running.
//
// Rendered through clack so the output stays readable in narrow terminals
// (left-gutter framing, no fixed-width tables that overflow).
import * as p from '@clack/prompts'
import pc from 'picocolors'
import { envGet } from '../lib/env.ts'
import { STACK_ENV } from '../lib/paths.ts'
import { stackProject } from '../lib/compose-env.ts'
import { getStackHealth, summarize } from '../lib/health.ts'
import {
  formatServiceLines,
  formatMachineLines,
  formatEndpointLines,
  type EndpointGroup,
} from '../lib/render-health.ts'
import { loadService } from '../lib/services.ts'
import { serviceEndpoints, isSecretRef } from '../lib/endpoints.ts'

export const runInfo = async (opts: { showSecrets?: boolean } = {}): Promise<void> => {
  const project = stackProject()
  const profiles = envGet(STACK_ENV, 'COMPOSE_PROFILES')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const machines = envGet(STACK_ENV, 'STACK_MACHINES')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

  p.intro(pc.bgCyan(pc.black(` ${project} `)))

  p.log.message(
    [
      pc.bold('Enabled'),
      `  Docker (${profiles.length})${profiles.length ? ':' : ''} ${pc.cyan(profiles.join(', ')) || pc.dim('(none)')}`,
      `  VMs    (${machines.length})${machines.length ? ':' : ''} ${pc.cyan(machines.join(', ')) || pc.dim('(none)')}`,
    ].join('\n'),
  )

  const h = await getStackHealth()
  const s = summarize(h)

  p.log.message(
    [pc.bold('Services'), ...formatServiceLines(h.services).map((l) => '  ' + l)].join('\n'),
  )

  p.log.message([pc.bold('VMs'), ...formatMachineLines(h.machines).map((l) => '  ' + l)].join('\n'))

  // Endpoints — orb-DNS URLs from each enabled service's `provides:` map.
  // Backends (pg/redis/rabbitmq) are skipped; dim = the backing container/VM
  // isn't running right now.
  const enabledDirs = [...new Set([...profiles, ...machines])]
  const epGroups: EndpointGroup[] = []
  for (const svc of enabledDirs) {
    const d = loadService(svc)
    if (!d || d.kind === 'backend') continue
    const eps = serviceEndpoints(svc)
    if (eps.length === 0) continue
    const rows = eps.map((ep) => ({
      ep,
      up: ep.isVm
        ? h.machines.some((m) => m.service === ep.service && m.run === 'running')
        : h.services.some((s) => s.service === ep.dnsName && s.run === 'running'),
    }))
    epGroups.push({ service: svc, rows })
  }
  if (epGroups.length) {
    const lines = [pc.bold('Endpoints')]
    const hasSecrets = epGroups.some((g) =>
      g.rows.some((r) => r.ep.auth.some((c) => isSecretRef(c.raw))),
    )
    if (hasSecrets && !opts.showSecrets) {
      lines.push(pc.dim('  Credentials shown as $VAR — run `info --show-pass` to reveal'), '')
    }
    lines.push(...formatEndpointLines(epGroups, opts.showSecrets).map((l) => '  ' + l))
    p.log.message(lines.join('\n'))
  }

  const allUp =
    s.upServices === s.totalServices && s.runningMachines === s.totalMachines && s.totalServices > 0
  const summary = `${s.healthyServices}/${s.totalServices} healthy · ${s.runningMachines}/${s.totalMachines} VM running`
  if (allUp && s.healthyServices === s.totalServices) {
    p.outro(pc.green('✓ stack up · ') + summary)
  } else if (s.upServices === 0 && s.runningMachines === 0) {
    p.outro(pc.dim('stack is down · ') + summary)
  } else {
    p.outro(pc.yellow('partial · ') + summary)
  }
}
