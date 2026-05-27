// commands/start-cleanup.ts — remove this project's exited provisioner
// containers (com.stack.role=provisioner labeled). One-shot.
//
// Auto-invoked at the end of `stack-cli start` when
// STACK_AUTO_REMOVE_PROVISIONERS=true, or manually any time.
import { $ } from 'zx'
import { stackProject } from '../lib/compose-env.ts'
import { log } from '../lib/log.ts'

export const runStartCleanup = async (): Promise<void> => {
  $.verbose = false
  const proj = stackProject()
  const out =
    await $`docker ps -aq --filter=label=com.stack.role=provisioner --filter=label=com.docker.compose.project=${proj} --filter=status=exited`
  const ids = out.stdout
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) {
    log('no exited provisioner containers to remove')
    return
  }
  await $`docker rm ${ids}`
  log(`removed ${ids.length} exited provisioner container(s)`)
}
