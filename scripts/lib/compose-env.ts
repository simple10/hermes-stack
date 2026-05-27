// compose-env.ts — pure helpers for what COMPOSE_PROFILES / project resolve
// to from .stack-node/.env (transitive closure of SERVICE_REQUIRES). Split
// out from compose.ts to avoid circular imports (services.ts <-> compose.ts).
import { envGet } from './env.ts'
import { STACK_ENV } from './paths.ts'
import { expandRequires, loadService } from './services.ts'

export const stackProject = (): string => envGet(STACK_ENV, 'COMPOSE_PROJECT_NAME') || 'aitools'

// stackProfiles — COMPOSE_PROFILES ∪ transitive SERVICE_REQUIRES, CSV.
// Drives the COMPOSE_PROFILES env var injected into every `docker compose`
// invocation (`dc()`), AND the include: list in the generated compose file.
export const stackProfiles = (seed?: string): string => {
  const raw = (seed ?? envGet(STACK_ENV, 'COMPOSE_PROFILES'))
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return expandRequires(raw).join(',')
}

// stackBackends — substrate (SERVICE_KIND=backend) members of stackProfiles.
// These are the `dc up -d <…>` targets `just start` brings up first.
export const stackBackends = (seed?: string): string[] => {
  const profiles = stackProfiles(seed)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const p of profiles) {
    const d = loadService(p)
    if (d && d.kind === 'backend') out.push(p)
  }
  return out
}

// stackMachines — STACK_MACHINES csv (VM service names, e.g. "hermes").
export const stackMachines = (): string[] =>
  envGet(STACK_ENV, 'STACK_MACHINES')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

// VM name = `${COMPOSE_PROJECT_NAME}-${SVC}` (dash, not underscore — orb
// rejects underscores). Mirrors stack_vm_name in stacklib.sh.
export const stackVmName = (svc: string): string => `${stackProject()}-${svc}`
