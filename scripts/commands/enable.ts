// commands/enable.ts — `stack-cli enable <svc> [<svc>...]`
//
// Cascades `requires` leaf-first. Each name added to the appropriate CSV
// (COMPOSE_PROFILES or STACK_MACHINES) + #>--- svc --- block
// appended/re-enabled in .stack/.env. Compose file is regenerated so the
// include: list stays consistent. Then (interactive only) offers to start
// the newly enabled service(s).
import pc from 'picocolors'
import * as p from '@clack/prompts'
import { ensureStackDir, enableService } from '../lib/stack.ts'
import { renderCompose } from '../lib/compose.ts'
import { startService, isServiceRunning } from '../lib/lifecycle.ts'
import { die } from '../lib/log.ts'

export const runEnable = async (args: readonly string[]): Promise<void> => {
  if (args.length === 0) die('usage: stack-cli enable <svc> [<svc>...]')
  ensureStackDir()
  for (const svc of args) {
    console.log(pc.cyan(`→ enabling ${svc}`))
    enableService(svc, (m) => console.log(pc.dim(`  · ${m}`)))
  }
  renderCompose()
  console.log(pc.green('enabled.'))

  // Offer to start. Skip entirely when non-interactive (CI / piped) so we
  // never block; the user can `stack-cli start` (whole stack) themselves.
  if (!process.stdout.isTTY) return
  const label = args.length > 1 ? `these ${args.length} services` : args[0]
  const ans = await p.confirm({ message: `Start ${label} now?`, initialValue: false })
  if (p.isCancel(ans) || !ans) return

  for (const svc of args) {
    if (await isServiceRunning(svc)) {
      console.log(pc.dim(`${svc} already running — skipping`))
      continue
    }
    console.log(pc.cyan(`→ starting ${svc}`))
    await startService(svc)
  }
}
