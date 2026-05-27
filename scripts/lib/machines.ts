// machines.ts — resolve which VM the user means.
//
// 0 enabled VMs  → null (caller dies with a helpful message).
// 1 enabled VM   → use it.
// N enabled VMs  → clack p.select prompts.
// Explicit name  → look it up directly; die if unknown.
import * as p from '@clack/prompts'
import { stackMachines, stackVmName } from './compose-env.ts'
import { die } from './log.ts'

export interface Machine {
  service: string // STACK_MACHINES entry, e.g. "hermes"
  vm: string // resolved orb VM name, e.g. "aitools-hermes"
}

export const listMachines = (): Machine[] =>
  stackMachines().map((service) => ({ service, vm: stackVmName(service) }))

export const selectMachine = async (explicit?: string): Promise<Machine | null> => {
  const machines = listMachines()
  if (machines.length === 0) return null
  if (explicit) {
    const m = machines.find((x) => x.service === explicit || x.vm === explicit)
    if (!m) {
      die(`unknown machine: ${explicit}. Enabled VMs: ${machines.map((x) => x.service).join(', ')}`)
      return null // unreachable
    }
    return m
  }
  if (machines.length === 1) return machines[0]
  const pick = await p.select<string>({
    message: 'Which VM?',
    options: machines.map((m) => ({ value: m.service, label: m.service, hint: m.vm })),
  })
  if (p.isCancel(pick)) {
    p.cancel('cancelled.')
    process.exit(1)
  }
  return machines.find((m) => m.service === pick) ?? null
}
