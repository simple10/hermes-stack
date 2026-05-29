// lifecycle.ts — start / stop a SINGLE service (docker or VM), reusably.
//
// Used by `enable` (offer to start) and `disable` (stop if running), and the
// home of the future `start <svc>` / `stop <svc>` commands. Whole-stack
// `start` / `stop` stay in their own commands — these operate on one service
// plus, for start, the preflight side of its dependency closure.
//
// Docker bring-up vs the full-stack pipeline: `dc up -d <svc>` lets Compose
// pull a service's `depends_on` (backends, provisioners) automatically. The
// one thing Compose can't do is mint LiteLLM virtual keys — that lives in
// litellm/preflight.ts — so startService runs the preflight of every service
// in the requires-closure that defines one (idempotent), which covers the
// `litellmKey: true` consumers before they come up.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as yamlParse } from 'yaml'
import { $ } from 'zx'
import { SERVICES_DIR } from './paths.ts'
import { dc } from './dc.ts'
import { renderCompose } from './compose.ts'
import { stackProject, stackVmName } from './compose-env.ts'
import { loadService, expandRequires } from './services.ts'
import { hasPhase, runPhase } from './svc.ts'
import { getStackHealth } from './health.ts'
import { orbStart, orbStop, orbMachineExists } from './orb.ts'
import { die, log, warn } from './log.ts'

// The compose service names declared in services/<svc>/compose.yaml (e.g.
// honcho -> [honcho-api, honcho-deriver, honcho-provision, honcho-schema]).
export const composeServiceNames = (svc: string): string[] => {
  const f = resolve(SERVICES_DIR, svc, 'compose.yaml')
  if (!existsSync(f)) return []
  try {
    const doc = yamlParse(readFileSync(f, 'utf8')) as { services?: Record<string, unknown> }
    return doc?.services ? Object.keys(doc.services) : []
  } catch {
    return []
  }
}

// Is the service currently running? VM -> machine running; docker -> any of
// its compose containers up.
export const isServiceRunning = async (svc: string): Promise<boolean> => {
  const d = loadService(svc)
  if (!d) return false
  const h = await getStackHealth()
  if (d.runner === 'vm') return h.machines.some((m) => m.service === svc && m.run === 'running')
  const names = new Set(composeServiceNames(svc))
  return h.services.some((s) => names.has(s.service) && s.run === 'running')
}

// Stop one service. Docker: stop + remove its containers (volumes retained,
// matching whole-stack `stop`). VM: orb stop (the VM is not deleted).
//
// Docker teardown targets containers by compose project + service label via
// raw `docker` — NOT `dc` — so it works regardless of whether the service is
// still in COMPOSE_PROFILES (disable removes it from the profile before the
// compose is regenerated) and needs no profile/compose state to be current.
export const stopService = async (svc: string): Promise<void> => {
  const d = loadService(svc)
  if (!d) {
    die(`stopService: no such service '${svc}'`)
    return
  }
  if (d.runner === 'vm') {
    const vm = stackVmName(svc)
    log(`orb stop ${vm}`)
    if (!(await orbStop(vm))) warn(`${vm}: orb stop returned non-zero (already stopped?)`)
    return
  }
  const names = new Set(composeServiceNames(svc))
  if (names.size === 0) {
    warn(`stopService(${svc}): no compose services found — nothing to stop`)
    return
  }
  $.verbose = false
  const project = stackProject()
  let lines: string[] = []
  try {
    const r =
      await $`docker ps -a --filter ${`label=com.docker.compose.project=${project}`} --format ${'{{.ID}}|{{.Label "com.docker.compose.service"}}'}`
    lines = r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    warn(`stopService(${svc}): docker ps failed (docker not running?)`)
    return
  }
  const ids = lines
    .map((l) => l.split('|'))
    .filter(([, svcName]) => names.has(svcName))
    .map(([id]) => id)
  if (ids.length === 0) {
    log(`${svc}: no running containers — nothing to stop`)
    return
  }
  log(`docker rm -f ${ids.length} container(s) for ${svc}`)
  try {
    await $`docker rm -f ${ids}`
  } catch {
    warn(`stopService(${svc}): docker rm -f returned non-zero`)
  }
}

// Start one service. Renders the compose, runs preflight/prestart across the
// requires-closure (idempotent; mints keys), then brings the service up
// (Compose pulls its depends_on) or starts + provisions the VM.
export const startService = async (svc: string): Promise<void> => {
  const d = loadService(svc)
  if (!d) {
    die(`startService: no such service '${svc}'`)
    return
  }
  renderCompose()
  const closure = expandRequires([svc]) // leaf-first: deps before svc

  for (const dep of closure) {
    if (await runPhase(dep, 'preflight')) log(`${dep}/preflight ✓`)
  }
  for (const dep of closure) {
    if (hasPhase(dep, 'prestart')) await runPhase(dep, 'prestart')
  }

  if (d.runner === 'vm') {
    const vm = stackVmName(svc)
    if (await orbMachineExists(vm)) {
      log(`orb start ${vm}`)
      await orbStart(vm)
    }
    if (!(await runPhase(svc, 'start')))
      warn(`${svc}: no start.ts — VM may need \`stack-cli build\` first`)
    return
  }

  const names = composeServiceNames(svc)
  log(`dc up -d ${names.join(' ')}`)
  const r = await dc(['up', '-d', ...names])
  if (r.code !== 0) die(`startService(${svc}): dc up -d failed`)
  await runPhase(svc, 'poststart')
}

// Restart one service. stopService removes the container, so startService
// creates a FRESH one — which re-reads .stack/.env. This is how an env-var
// change (e.g. LOCALHOST_PROXY_PORTS) actually gets picked up: a plain docker
// restart re-runs the entrypoint but keeps the env baked in at create time.
export const restartService = async (svc: string): Promise<void> => {
  await stopService(svc)
  await startService(svc)
}
