// commands/update.ts — discover and apply upstream version bumps.
//
// Read-only: `stack-cli update [svc]` reports current -> latest-available.
// Apply: `stack-cli update <svc> [--to V|--latest|--channel C|--dry-run]`
// snapshots .stack/.env -> bumps the knob -> build (resolve) -> restart ->
// out-of-band health-gate -> rolls back with remediation on failure.
import pc from 'picocolors'
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { serviceVersionKnobs, serviceTagKnobs, type VersionKnob } from '../lib/services.ts'
import { stackGet, stackUpsert } from '../lib/stack.ts'
import { generatedGet } from '../lib/generated.ts'
import { requestedKey } from '../lib/versions.ts'
import { listVersions, pickCandidates } from '../lib/version-sources.ts'
import { resolveChannel, resolveTarget, channelKey } from '../lib/update-policy.ts'
import { stackProfiles, stackMachines, stackVmName } from '../lib/compose-env.ts'
import { STACK_ENV, STACK_ROOT } from '../lib/paths.ts'
import { healthProbeSpec, probeOnce } from '../lib/health-probe.ts'
import { getStackHealth } from '../lib/health.ts'
import { loadBearingServices } from '../lib/load-bearing.ts'
import { restartService } from '../lib/lifecycle.ts'
import { orbExec } from '../lib/orb.ts'
import { parseHermesVersion } from '../../services/hermes/hermes-version.ts'
import { runBuild } from './build.ts'

export interface KnobStatus {
  svc: string
  key: string
  current: string
  latest: string
  newer: boolean
  digestPinned: boolean
  top: string[]
}

const isDigest = (v: string): boolean => /^sha256:/.test(v) || /^[0-9a-f]{32,}$/i.test(v)

// The version a knob is currently pinned to: the user's in-block knob value,
// else the resolved requested value, else the service.yaml default.
const currentVersion = (svc: string, knob: VersionKnob): string =>
  stackGet(knob.key) || generatedGet(svc, requestedKey(knob, svc)) || knob.default

const discoverKnob = async (svc: string, knob: VersionKnob): Promise<KnobStatus> => {
  const current = currentVersion(svc, knob)
  if (isDigest(current)) {
    return {
      svc,
      key: knob.key,
      current,
      latest: current,
      newer: false,
      digestPinned: true,
      top: [],
    }
  }
  const tags = await listVersions(knob.repo)
  const { regex, sort } = resolveChannel(svc, current, stackGet(channelKey(svc)) || undefined)
  const top = pickCandidates(tags, { channel: regex, sort })
  const latest = top[0] ?? current
  return {
    svc,
    key: knob.key,
    current,
    latest,
    newer: !!top[0] && top[0] !== current,
    digestPinned: false,
    top: top.slice(0, 3),
  }
}

// All discoverable knobs: images:/source: blocks PLUS plain-tag knobs parsed
// from the compose image: line (deduped — an explicit knob wins).
export const discoverableKnobs = (svc: string): VersionKnob[] => {
  const out = [...serviceVersionKnobs(svc)]
  const have = new Set(out.map((k) => k.key))
  for (const k of serviceTagKnobs(svc)) if (!have.has(k.key)) out.push(k)
  return out
}

export const discoverService = async (svc: string): Promise<KnobStatus[]> =>
  Promise.all(discoverableKnobs(svc).map((k) => discoverKnob(svc, k)))

// ---- self-updating VMs ---------------------------------------------------
// hermes has no image/source knob: it's a VM that tracks an upstream git repo
// and updates IN PLACE via `hermes update`. The canonical `hermes --version`
// reports both the running version and how far behind upstream it is, so we
// surface that in the same report and apply via `hermes update` in the VM.
const SELF_UPDATING_VMS = new Set(['hermes'])

export interface VmStatus {
  svc: string
  version: string // running semver ('' when unreachable/unparseable)
  behind: number | null // commits behind upstream (null = up to date / unknown)
  reachable: boolean
}

export const discoverVm = async (svc: string): Promise<VmStatus> => {
  try {
    const out = await orbExec(stackVmName(svc), 'hermes --version')
    const { version, behind } = parseHermesVersion(out)
    return { svc, version, behind, reachable: version !== '' }
  } catch {
    return { svc, version: '', behind: null, reachable: false }
  }
}

const vmHasUpdate = (v: VmStatus): boolean => v.reachable && (v.behind ?? 0) > 0

const renderVmRow = (v: VmStatus, name: string): string => {
  if (!v.reachable)
    return `  ${pc.dim('○')} ${name}  ${pc.dim('unreachable')}  ${pc.dim('(VM stopped?)')}`
  const ver = pc.dim(`v${v.version}`)
  if (vmHasUpdate(v))
    return `  ${pc.yellow('▲')} ${name}  ${ver}  ${pc.yellow(`${v.behind} commit${v.behind! > 1 ? 's' : ''} behind`)} ${pc.dim("— run 'hermes update'")}`
  return `  ${pc.green('●')} ${name}  ${ver}  ${pc.dim('up to date')}`
}

const enabledServices = (): string[] => [
  ...stackProfiles()
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  ...stackMachines(),
]

// Label a row: the service name, suffixed with the knob prefix only when the
// service has more than one knob (e.g. firecrawl/FIRECRAWL_API).
const rowLabel = (s: KnobStatus, perSvcCount: Map<string, number>): string =>
  (perSvcCount.get(s.svc) ?? 1) > 1 ? `${s.svc}/${s.key.replace(/_VERSION$/, '')}` : s.svc

const renderRow = (s: KnobStatus, name: string): string => {
  if (s.digestPinned)
    return `  ${pc.dim('○')} ${name}  ${pc.dim(s.current)}  ${pc.dim('(digest-pinned — no channel)')}`
  if (s.newer)
    return `  ${pc.yellow('▲')} ${name}  ${s.current} ${pc.dim('→')} ${pc.green(s.latest)}  ${pc.dim('update available')}`
  return `  ${pc.green('●')} ${name}  ${pc.dim(s.current)}  ${pc.dim('up to date')}`
}

const report = (rows: KnobStatus[], vms: VmStatus[] = []): void => {
  if (rows.length === 0 && vms.length === 0) {
    console.log(pc.dim('  (no versioned services)'))
    return
  }
  const perSvc = new Map<string, number>()
  for (const r of rows) perSvc.set(r.svc, (perSvc.get(r.svc) ?? 0) + 1)
  const labels = new Map(rows.map((r) => [r, rowLabel(r, perSvc)]))
  // Shared column width across knob + VM rows so both sections align.
  const w = [...labels.values(), ...vms.map((v) => v.svc)].reduce(
    (m, l) => Math.max(m, l.length),
    0,
  )
  for (const r of rows) console.log(renderRow(r, labels.get(r)!.padEnd(w)))
  for (const v of vms) console.log(renderVmRow(v, v.svc.padEnd(w)))
  const n = rows.filter((r) => r.newer).length + vms.filter(vmHasUpdate).length
  console.log(
    '\n' +
      (n
        ? pc.yellow(`${n} update${n > 1 ? 's' : ''} available`) +
          pc.dim(' — `stack-cli update <svc> --latest` (or `--to <ver>`) to apply')
        : pc.green('everything up to date')),
  )
}

export const updateService = async (svc: string): Promise<void> => {
  if (SELF_UPDATING_VMS.has(svc)) {
    report([], [await discoverVm(svc)])
    return
  }
  if (discoverableKnobs(svc).length === 0) {
    console.log(pc.dim(`  ${svc}: no version knob (not a versioned service)`))
    return
  }
  report(await discoverService(svc))
}

export const updateAll = async (): Promise<void> => {
  const enabled = enabledServices()
  const svcs = enabled.filter((s) => discoverableKnobs(s).length > 0)
  const vmSvcs = enabled.filter((s) => SELF_UPDATING_VMS.has(s))
  console.log(pc.bold(`Checking ${svcs.length + vmSvcs.length} services for updates…\n`))
  const [all, vms] = await Promise.all([
    Promise.all(svcs.map((s) => discoverService(s))).then((r) => r.flat()),
    Promise.all(vmSvcs.map((s) => discoverVm(s))),
  ])
  report(all, vms)
}

// ---- apply pipeline (P4) -------------------------------------------------
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface ApplyOpts {
  to?: string
  channel?: string
  dryRun?: boolean
}

interface Plan {
  knob: VersionKnob
  current: string
  target: string
}

// Poll the out-of-band probe (image-tooling-independent) until the service is
// reachable, or fall back to Docker run/health when no probe is declared.
const healthGate = async (svc: string, tries = 12, delayMs = 2500): Promise<boolean> => {
  const spec = healthProbeSpec(svc)
  for (let i = 0; i < tries; i++) {
    if (spec) {
      if (await probeOnce(spec, 3000)) return true
    } else {
      const s = (await getStackHealth()).services.find((x) => x.service === svc)
      if (s && s.run === 'running' && s.health !== 'unhealthy') return true
    }
    await sleep(delayMs)
  }
  return false
}

// After a bump, if a LOAD-BEARING service is out-of-band reachable but Docker
// reports its container unhealthy, the new image likely broke the in-container
// healthcheck — which gates `service_healthy` dependents. Warn loudly (5b: the
// auto-injecting fix that swaps in a /proc probe is a follow-up).
const warnIfLoadBearingProbeBroken = async (svc: string): Promise<void> => {
  if (!loadBearingServices().has(svc)) return
  const s = (await getStackHealth()).services.find((x) => x.service === svc)
  if (!s || s.health !== 'unhealthy') return
  console.error(
    pc.yellow(`\n⚠ ${svc} is reachable, but Docker reports the container UNHEALTHY.`) +
      pc.yellow(
        `\n  ${svc} is load-bearing — services that gate on it (condition: service_healthy)`,
      ) +
      pc.yellow(
        `\n  may HANG at the next start. The new image likely broke its in-container probe.`,
      ) +
      pc.dim(
        `\n  Fix the healthcheck in services/${svc}/compose.yaml (a /proc-based probe needs no` +
          `\n  image tooling — see services/cliproxyapi), or revert: stack-cli update ${svc} --to <prev>.`,
      ),
  )
}

const snapshot = (svc: string): string => {
  const dir = resolve(STACK_ROOT, '_bak')
  mkdirSync(dir, { recursive: true })
  const bak = resolve(dir, `.env.pre-update-${svc}`)
  copyFileSync(STACK_ENV, bak)
  return bak
}

// Apply a self-updating VM bump: run the canonical `hermes update` IN the VM
// (live output so any prompt is visible), then re-read the version. No knob /
// rebuild / .stack/.env churn — the VM owns its own update.
const applyVmUpdate = async (svc: string, opts: ApplyOpts): Promise<void> => {
  const before = await discoverVm(svc)
  if (!before.reachable) {
    console.error(pc.red(`  ${svc}: VM unreachable — is it running?  (stack-cli start ${svc})`))
    return
  }
  if (!vmHasUpdate(before)) {
    console.log(pc.green(`  ${svc}: already up to date (v${before.version})`))
    return
  }
  console.log(
    pc.yellow(
      `  ▲ ${svc}: ${before.behind} commit${before.behind! > 1 ? 's' : ''} behind → \`hermes update\``,
    ),
  )
  if (opts.dryRun) {
    console.log(pc.dim('\n  --dry-run: no changes applied'))
    return
  }
  console.log(pc.bold(`\nrunning \`hermes update\` in ${stackVmName(svc)}…`))
  try {
    await orbExec(stackVmName(svc), 'hermes update', { stdio: 'inherit' })
  } catch (e) {
    console.error(pc.red(`\n✗ \`hermes update\` failed: ${(e as Error).message}`))
    return
  }
  const after = await discoverVm(svc)
  console.log(
    pc.green(`\n✓ ${svc} now v${after.version}`) +
      (vmHasUpdate(after) ? pc.yellow(` (still ${after.behind} behind)`) : ''),
  )
}

export const applyUpdate = async (svc: string, opts: ApplyOpts): Promise<void> => {
  if (SELF_UPDATING_VMS.has(svc)) return applyVmUpdate(svc, opts)
  const knobs = discoverableKnobs(svc)
  if (knobs.length === 0) {
    console.log(pc.dim(`  ${svc}: no version knob (not a versioned service)`))
    return
  }
  // Record the channel choice (block-aware) BEFORE discovery so it applies.
  if (opts.channel) {
    stackUpsert(channelKey(svc), opts.channel)
    console.log(pc.dim(`  channel: ${channelKey(svc)}=${opts.channel}`))
  }

  const plans: Plan[] = []
  for (const knob of knobs) {
    const current = currentVersion(svc, knob)
    if (isDigest(current) && !opts.to) {
      console.log(pc.dim(`  ${knob.key}: digest-pinned — pass --to <tag> to change`))
      continue
    }
    const tags = await listVersions(knob.repo)
    const override = opts.channel ?? (stackGet(channelKey(svc)) || undefined)
    const { regex, sort } = resolveChannel(svc, current, override)
    const target = resolveTarget(current, pickCandidates(tags, { channel: regex, sort }), opts.to)
    if (!target) {
      console.log(pc.green(`  ${knob.key}: already up to date (${current})`))
      continue
    }
    plans.push({ knob, current, target })
  }
  if (plans.length === 0) return

  for (const p of plans) console.log(pc.yellow(`  ▲ ${p.knob.key}: ${p.current} → ${p.target}`))

  if (opts.dryRun) {
    console.log(pc.dim('\n  --dry-run: no changes applied'))
    return
  }

  const bak = snapshot(svc)
  for (const p of plans) stackUpsert(p.knob.key, p.target)

  console.log(pc.bold(`\nresolving + rebuilding…`))
  await runBuild()
  console.log(pc.bold(`restarting ${svc}…`))
  await restartService(svc)

  console.log(pc.bold(`health-gating ${svc} (out-of-band)…`))
  if (await healthGate(svc)) {
    await warnIfLoadBearingProbeBroken(svc)
    console.log(pc.green(`\n✓ ${svc} updated and healthy`))
    return
  }

  // Rollback — restore the pre-update .stack/.env and rebuild/restart.
  console.error(pc.red(`\n✗ ${svc} did not become healthy after the bump — rolling back`))
  copyFileSync(bak, STACK_ENV)
  await runBuild()
  await restartService(svc)
  console.error(
    pc.yellow('rolled back. last-known-good restored:') +
      plans.map((p) => `\n  ${p.knob.key}=${p.current}`).join(''),
  )
  console.error(
    pc.dim(
      `\nTo retry a specific version:  stack-cli update ${svc} --to <version>\n` +
        `Or edit .stack/.env (${plans.map((p) => p.knob.key).join(', ')}) and run \`stack-cli build && stack-cli restart ${svc}\`.`,
    ),
  )
}

// `update [--to X] [--channel C] [svc...]`. No service or no apply flag =>
// read-only report; a service with --to/--channel => apply.
export const runUpdate = async (args: readonly string[]): Promise<void> => {
  const svcs: string[] = []
  let to: string | undefined
  let channel: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--to') to = args[++i]
    else if (a === '--channel') channel = args[++i]
    else if (!a.startsWith('-')) svcs.push(a)
  }
  const dryRun = args.includes('--dry-run')
  const apply =
    to !== undefined ||
    channel !== undefined ||
    args.includes('--latest') ||
    args.includes('--yes') ||
    args.includes('-y') ||
    dryRun

  if (svcs.length === 0) return updateAll()
  for (const svc of svcs) {
    console.log(pc.cyan(`→ update ${svc}`))
    if (apply) await applyUpdate(svc, { to, channel, dryRun })
    else await updateService(svc)
  }
}
