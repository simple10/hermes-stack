// commands/hermes.ts — run a hermes-cli command inside the hermes VM.
//
//   ./stack-cli hermes              # opens the hermes TUI
//   ./stack-cli hermes config show
//   ./stack-cli hermes setup
//
// Targets the VM running the `hermes` service if present; otherwise
// falls back to the single-VM / prompt selector.
import { listMachines, selectMachine } from '../lib/machines.ts'
import { orbInteractive } from '../lib/orb.ts'
import { die } from '../lib/log.ts'

export const runHermes = async (args: readonly string[]): Promise<void> => {
  // Prefer a VM whose service is literally "hermes" — that's where the
  // CLI is installed. If there are several VMs and none is `hermes`,
  // fall through to the generic prompt.
  const all = listMachines()
  if (all.length === 0) die('no VMs enabled (STACK_MACHINES is empty)')

  const preferred = all.find((m) => m.service === 'hermes')
  const target = preferred ?? (await selectMachine())
  if (!target) die('no VM selected')

  await orbInteractive(target!.vm, ['hermes', ...args])
}
