// commands/stop.ts — bring the stack down. Order:
//   1. (optional) chrome-cdp teardown via runChromeCdpStop
//   2. orb stop each STACK_MACHINES VM (best-effort; doesn't fail the
//      command if a machine is already stopped or doesn't exist)
//   3. dc down --remove-orphans (volumes retained — recreating from
//      scratch is the supported model; remove volumes manually for a
//      clean slate)
import pc from 'picocolors'
import { $ } from 'zx'
import { dc } from '../lib/dc.ts'
import { stackMachines, stackVmName } from '../lib/compose-env.ts'
import { log } from '../lib/log.ts'

export const runStop = async (): Promise<void> => {
  $.verbose = false
  // Chrome-cdp teardown is a no-op if it wasn't running; import lazily to
  // avoid a circular dependency in tests.
  try {
    const { runChromeCdpStop } = await import('./chrome-cdp.ts')
    await runChromeCdpStop(false)
  } catch {
    /* not wired yet */
  }

  const machines = stackMachines()
  for (const svc of machines) {
    const vm = stackVmName(svc)
    console.log(pc.cyan(`→ orb stop ${vm}`))
    try {
      await $`orb stop ${vm}`
    } catch {
      log(`${vm}: orb stop returned non-zero (already stopped?) — ignoring`)
    }
  }

  console.log(pc.bold('dc down --remove-orphans'))
  const r = await dc(['down', '--remove-orphans'])
  if (r.code !== 0)
    console.error(
      pc.yellow('dc down returned non-zero (some containers may have already been gone)'),
    )
  console.log(pc.green('stop done.'))
}
