// update-policy.ts — resolve which versions a service tracks.
//
// service.yaml `update:` is declarative policy (channels/default/sort). The
// user's ACTIVE channel lives in .stack/.env as <SVC_UC>_UPDATE_CHANNEL (read
// by the caller, passed as `override`). With no update: block we derive a
// "same shape" channel from the current pin.
import { loadService } from './services.ts'
import { channelFromVersion } from './version-sources.ts'

export const channelKey = (svc: string): string =>
  `${svc.toUpperCase().replace(/-/g, '_')}_UPDATE_CHANNEL`

export interface ResolvedChannel {
  regex: RegExp
  sort: 'semver' | 'date'
  name: string
}

export const resolveChannel = (
  svc: string,
  current: string,
  override?: string,
): ResolvedChannel => {
  const u = loadService(svc)?.update
  if (u) {
    const name = override || u.default
    const src = u.channels[name]
    if (src) return { regex: new RegExp(src), sort: u.sort, name }
  }
  return { regex: channelFromVersion(current), sort: 'semver', name: override || 'auto' }
}

// The version to apply: an explicit --to, else the newest candidate when it is
// newer than current, else null (nothing to do).
export const resolveTarget = (
  current: string,
  candidates: string[],
  to?: string,
): string | null => {
  if (to) return to
  const latest = candidates[0]
  return latest && latest !== current ? latest : null
}
