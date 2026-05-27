// commands/ssh.ts — interactive shell into a stack VM via `orb -m <vm>`.
//
//   ./stack-cli ssh           # single VM: connects directly; multiple: prompts
//   ./stack-cli ssh <machine> # connects to the named VM (must be in STACK_MACHINES)
import { selectMachine } from '../lib/machines.ts'
import { orbInteractive } from '../lib/orb.ts'
import { die } from '../lib/log.ts'

export const runSsh = async (args: readonly string[]): Promise<void> => {
  const m = await selectMachine(args[0])
  if (!m) die('no VMs enabled (STACK_MACHINES is empty)')
  await orbInteractive(m!.vm)
}
