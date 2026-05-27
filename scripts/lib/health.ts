// health.ts — runtime state of this project's containers + VMs.
//
// Single entry point: `getStackHealth()` returns a structured snapshot.
// Used by both `stack-cli info` (friendly overview) and `stack-cli status`
// (detailed diagnostic). No formatting concerns here — callers render.
//
// docker ps state comes from one `docker ps -a` call filtered by the
// compose-project label. Health is parsed out of the Status string
// (`Up 2 minutes (healthy)` / `(unhealthy)` / `(health: starting)` etc.)
// — cheaper than a per-container `docker inspect`.
//
// VM state comes from `orb list -f json`, narrowed to STACK_MACHINES
// resolved through stackVmName().
import { $ } from 'zx'
import { stackProject, stackMachines, stackVmName, stackProfiles } from './compose-env.ts'

export type RunState = 'running' | 'restarting' | 'paused' | 'exited' | 'created' | 'missing'
export type HealthState = 'healthy' | 'unhealthy' | 'starting' | 'none'

export interface ServiceHealth {
  service: string // logical service name (compose service)
  containerName: string // full container name; "" if missing
  image: string
  status: string // raw `docker ps` Status string
  run: RunState
  health: HealthState
  enabled: boolean // is this service in the active COMPOSE_PROFILES closure?
}

export interface MachineHealth {
  service: string // STACK_MACHINES entry, e.g. "hermes"
  vm: string // resolved VM name, e.g. "hermes-node-test-hermes"
  run: 'running' | 'stopped' | 'missing'
}

export interface StackHealth {
  project: string
  services: ServiceHealth[]
  machines: MachineHealth[]
}

// Parse the "Status" string from `docker ps` into (run, health).
const parseStatus = (status: string): { run: RunState; health: HealthState } => {
  let run: RunState = 'missing'
  if (/^Up\b/.test(status)) run = 'running'
  else if (/^Restarting/.test(status)) run = 'restarting'
  else if (/^Paused/.test(status)) run = 'paused'
  else if (/^Exited/.test(status)) run = 'exited'
  else if (/^Created/.test(status)) run = 'created'
  let health: HealthState = 'none'
  if (/\(healthy\)/.test(status)) health = 'healthy'
  else if (/\(unhealthy\)/.test(status)) health = 'unhealthy'
  else if (/\(health: starting\)/.test(status)) health = 'starting'
  return { run, health }
}

export const getStackHealth = async (): Promise<StackHealth> => {
  $.verbose = false
  const project = stackProject()
  const enabledServices = new Set(
    stackProfiles()
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  )

  // -- containers ----------------------------------------------------------
  let dockerLines: string[] = []
  try {
    const r =
      await $`docker ps -a --filter ${`label=com.docker.compose.project=${project}`} --format ${'{{.Names}}|{{.Status}}|{{.Image}}|{{.Label "com.docker.compose.service"}}'}`
    dockerLines = r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    /* docker missing */
  }

  const byService = new Map<string, ServiceHealth>()
  for (const line of dockerLines) {
    const [name, status, image, service] = line.split('|')
    if (!service) continue
    // Skip provisioner one-shots from the headline list — they're noise
    // post-start (always Exited 0). Status command may opt-in via a flag
    // later if needed.
    if (/-provision-|-schema-/.test(name)) continue
    const { run, health } = parseStatus(status)
    byService.set(service, {
      service,
      containerName: name,
      image,
      status,
      run,
      health,
      enabled:
        enabledServices.has(service.replace(/-(api|deriver|ui)$/, () => '')) ||
        enabledServices.has(service),
    })
  }

  // Surface enabled services that have NO container yet (missing).
  for (const svc of enabledServices) {
    if (!byService.has(svc)) {
      byService.set(svc, {
        service: svc,
        containerName: '',
        image: '',
        status: '(no container)',
        run: 'missing',
        health: 'none',
        enabled: true,
      })
    }
  }
  // Honcho splits into honcho-api + honcho-deriver inside compose, but
  // COMPOSE_PROFILES lists "honcho". Drop the synthetic missing row when
  // either real container exists.
  if (byService.has('honcho-api') || byService.has('honcho-deriver')) {
    byService.delete('honcho')
  }

  const services = [...byService.values()].sort((a, b) => a.service.localeCompare(b.service))

  // -- machines ------------------------------------------------------------
  const wanted = new Map<string, string>() // vm name -> service
  for (const svc of stackMachines()) wanted.set(stackVmName(svc), svc)

  let allOrb: { name: string; state: string }[] = []
  try {
    const r = await $`orb list -f json`
    const parsed = JSON.parse(r.stdout || '[]')
    if (Array.isArray(parsed)) {
      allOrb = parsed.map((m: { name?: string; state?: string }) => ({
        name: String(m.name ?? ''),
        state: String(m.state ?? ''),
      }))
    }
  } catch {
    /* orb missing or not running */
  }

  const machines: MachineHealth[] = []
  for (const [vmName, service] of wanted) {
    const m = allOrb.find((x) => x.name === vmName)
    let run: MachineHealth['run'] = 'missing'
    if (m) run = m.state === 'running' ? 'running' : 'stopped'
    machines.push({ service, vm: vmName, run })
  }

  return { project, services, machines }
}

// Quick aggregate: is everything we expect to be running, running + healthy?
export const summarize = (
  h: StackHealth,
): {
  totalServices: number
  upServices: number
  healthyServices: number
  totalMachines: number
  runningMachines: number
} => {
  const totalServices = h.services.length
  let upServices = 0
  let healthyServices = 0
  for (const s of h.services) {
    if (s.run === 'running') upServices++
    if (s.health === 'healthy' || (s.health === 'none' && s.run === 'running')) healthyServices++
  }
  return {
    totalServices,
    upServices,
    healthyServices,
    totalMachines: h.machines.length,
    runningMachines: h.machines.filter((m) => m.run === 'running').length,
  }
}
