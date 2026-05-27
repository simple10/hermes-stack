// commands/status.ts — detailed runtime status. Same data source as
// `info` (lib/health.ts) but verbose (raw `docker ps` Status + image).
//
// Rendered through clack so narrow terminals don't shred the layout.
// Machine list is scoped to STACK_MACHINES (resolved via stackVmName) —
// no longer dumps every orb machine on the Mac.
import * as p from '@clack/prompts'
import pc from 'picocolors'
import { stackProject } from '../lib/compose-env.ts'
import { getStackHealth, summarize } from '../lib/health.ts'
import { formatServiceLines, formatMachineLines } from '../lib/render-health.ts'

export const runStatus = async (): Promise<void> => {
  const project = stackProject()
  p.intro(pc.bgCyan(pc.black(` ${project} status `)))

  const h = await getStackHealth()
  const s = summarize(h)

  p.log.message(
    [
      pc.bold('Docker services') + pc.dim(` (project=${project})`),
      ...formatServiceLines(h.services, { showImage: true }).map((l) => '  ' + l),
    ].join('\n'),
  )

  p.log.message(
    [
      pc.bold('VMs') + pc.dim(' (this stack only)'),
      ...formatMachineLines(h.machines).map((l) => '  ' + l),
    ].join('\n'),
  )

  const summary = `${s.healthyServices}/${s.totalServices} healthy · ${s.runningMachines}/${s.totalMachines} VM running`
  p.outro(summary)
}
