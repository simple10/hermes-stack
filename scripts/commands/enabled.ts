// commands/enabled.ts — print currently-enabled docker profiles + VMs.
import pc from 'picocolors'
import { envGet } from '../lib/env.ts'
import { STACK_ENV } from '../lib/paths.ts'
import { stackProfiles } from '../lib/compose-env.ts'

export const runEnabled = async (): Promise<void> => {
  const profs = envGet(STACK_ENV, 'COMPOSE_PROFILES')
  const machs = envGet(STACK_ENV, 'STACK_MACHINES')
  console.log(pc.bold('Docker services (COMPOSE_PROFILES):'))
  for (const s of csv(profs)) console.log(`  - ${s}`)
  console.log(pc.bold('VM services (STACK_MACHINES):'))
  for (const s of csv(machs)) console.log(`  - ${s}`)
  console.log(pc.dim(`\nTransitive closure (incl. backends): ${stackProfiles()}`))
}

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
