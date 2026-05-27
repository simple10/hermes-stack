// commands/build.ts — `stack-cli build`.
//
// Phase 1: resolve every services/*/service.env's *_IMAGE_REPO+_DEFAULT
//          pair to a concrete digest, written into .stack-node/<svc>/
//          .generated.env. Runs UNCONDITIONALLY because Compose include:
//          parses every file on every dc call.
//
// Phase 2: run each enabled service's build.ts (if present), iterating
//          over the transitive COMPOSE_PROFILES closure first, then
//          STACK_MACHINES. Substrate services (pg) get their build.ts
//          run too — kind=backend is just a UI hint.
import pc from 'picocolors'
import { renderCompose } from '../lib/compose.ts'
import { resolveAllImages } from '../lib/images.ts'
import { stackProfiles, stackMachines } from '../lib/compose-env.ts'
import { hasPhase, runPhase } from '../lib/svc.ts'

export const runBuild = async (): Promise<void> => {
  console.log(pc.bold('Phase 1: resolve image digests'))
  await resolveAllImages()

  // Refresh compose YAML now that we know which services are enabled.
  renderCompose()

  console.log(pc.bold('\nPhase 2: per-service build.ts'))
  const dockerSeq = stackProfiles()
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const vmSeq = stackMachines()
  for (const svc of [...dockerSeq, ...vmSeq]) {
    if (!hasPhase(svc, 'build')) {
      console.log(pc.dim(`  · ${svc} — no build.ts (skip)`))
      continue
    }
    console.log(pc.cyan(`→ ${svc}/build.ts`))
    await runPhase(svc, 'build')
  }
  console.log(pc.green('\nbuild done.'))
}
