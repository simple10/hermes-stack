// commands/disable.ts — `stack-cli disable <svc> [<svc>...]`
//
// Refuses (process.exit 1) if any enabled service has `requires` containing
// this one. No force flag. After a successful disable, stops + removes the
// service's running containers / VM (volumes + VM are retained).
import pc from 'picocolors'
import { disableService } from '../lib/stack.ts'
import { stopService } from '../lib/lifecycle.ts'
import { renderCompose } from '../lib/compose.ts'
import { die } from '../lib/log.ts'

export const runDisable = async (args: readonly string[]): Promise<void> => {
  if (args.length === 0) die('usage: stack-cli disable <svc> [<svc>...]')
  for (const svc of args) {
    // disableService dies (exit 1) if dependants exist — so we only reach
    // stopService when the disable actually proceeds.
    const { changed } = disableService(svc)
    console.log(changed ? pc.cyan(`✓ disabled ${svc}`) : pc.dim(`${svc} already disabled`))
    await stopService(svc)
  }
  renderCompose()
}
