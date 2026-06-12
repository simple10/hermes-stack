// commands/update.ts — discover (and later apply) upstream version bumps.
//
// P3 surface: read-only "outdated" report. `stack-cli update` reports every
// enabled service's current -> latest-available; `stack-cli update <svc>`
// reports one. Apply (snapshot -> bump -> resolve -> build -> restart ->
// health-gate) lands in P4.
import pc from 'picocolors'
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { serviceVersionKnobs, serviceTagKnobs, type VersionKnob } from '../lib/services.ts'
import { stackGet, stackUpsert } from '../lib/stack.ts'
import { generatedGet } from '../lib/generated.ts'
import { requestedKey } from '../lib/versions.ts'
import { listVersions, pickCandidates } from '../lib/version-sources.ts'
import { resolveChannel, resolveTarget, channelKey } from '../lib/update-policy.ts'
import { stackProfiles, stackMachines } from '../lib/compose-env.ts'
import { STACK_ENV, STACK_ROOT } from '../lib/paths.ts'
import { healthProbeSpec, probeOnce } from '../lib/health-probe.ts'
import { getStackHealth } from '../lib/health.ts'
import { restartService } from '../lib/lifecycle.ts'
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

const report = (rows: KnobStatus[]): void => {
  if (rows.length === 0) {
    console.log(pc.dim('  (no versioned services)'))
    return
  }
  const perSvc = new Map<string, number>()
  for (const r of rows) perSvc.set(r.svc, (perSvc.get(r.svc) ?? 0) + 1)
  const labels = new Map(rows.map((r) => [r, rowLabel(r, perSvc)]))
  const w = [...labels.values()].reduce((m, l) => Math.max(m, l.length), 0)
  for (const r of rows) console.log(renderRow(r, labels.get(r)!.padEnd(w)))
  const n = rows.filter((r) => r.newer).length
  console.log(
    '\n' +
      (n
        ? pc.yellow(`${n} update${n > 1 ? 's' : ''} available`) +
          pc.dim(' — `stack-cli update <svc> --latest` (or `--to <ver>`) to apply')
        : pc.green('everything up to date')),
  )
}

export const updateService = async (svc: string): Promise<void> => {
  if (discoverableKnobs(svc).length === 0) {
    console.log(pc.dim(`  ${svc}: no version knob (not a versioned service)`))
    return
  }
  report(await discoverService(svc))
}

export const updateAll = async (): Promise<void> => {
  const svcs = enabledServices().filter((s) => discoverableKnobs(s).length > 0)
  console.log(pc.bold(`Checking ${svcs.length} services for updates…\n`))
  const all = (await Promise.all(svcs.map((s) => discoverService(s)))).flat()
  report(all)
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

const snapshot = (svc: string): string => {
  const dir = resolve(STACK_ROOT, '_bak')
  mkdirSync(dir, { recursive: true })
  const bak = resolve(dir, `.env.pre-update-${svc}`)
  copyFileSync(STACK_ENV, bak)
  return bak
}

export const applyUpdate = async (svc: string, opts: ApplyOpts): Promise<void> => {
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
