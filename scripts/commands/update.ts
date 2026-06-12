// commands/update.ts — discover (and later apply) upstream version bumps.
//
// P3 surface: read-only "outdated" report. `stack-cli update` reports every
// enabled service's current -> latest-available; `stack-cli update <svc>`
// reports one. Apply (snapshot -> bump -> resolve -> build -> restart ->
// health-gate) lands in P4.
import pc from 'picocolors'
import { serviceVersionKnobs, serviceTagKnobs, type VersionKnob } from '../lib/services.ts'
import { stackGet } from '../lib/stack.ts'
import { generatedGet } from '../lib/generated.ts'
import { requestedKey } from '../lib/versions.ts'
import { listVersions, pickCandidates, channelFromVersion } from '../lib/version-sources.ts'
import { stackProfiles, stackMachines } from '../lib/compose-env.ts'

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
  const top = pickCandidates(tags, { channel: channelFromVersion(current), sort: 'semver' })
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
          pc.dim(' — run `stack-cli update <svc>` to apply (coming in P4)')
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
