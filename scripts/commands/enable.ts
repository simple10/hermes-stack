// commands/enable.ts — `stack-cli enable <svc> [<svc>...]`
//
// Cascades SERVICE_REQUIRES leaf-first. Each name added to the
// appropriate CSV (COMPOSE_PROFILES or STACK_MACHINES) + #>--- svc ---
// block appended/re-enabled in .stack-node/.env. Compose file is
// regenerated so the include: list stays consistent.
import pc from 'picocolors'
import { ensureStackDir, enableService } from '../lib/stack.ts'
import { renderCompose } from '../lib/compose.ts'
import { die } from '../lib/log.ts'

export const runEnable = async (args: readonly string[]): Promise<void> => {
  if (args.length === 0) die('usage: stack-cli enable <svc> [<svc>...]')
  ensureStackDir()
  for (const svc of args) {
    console.log(pc.cyan(`→ enabling ${svc}`))
    enableService(svc, (m) => console.log(pc.dim(`  · ${m}`)))
  }
  renderCompose()
  console.log(pc.green('done.'))
}
