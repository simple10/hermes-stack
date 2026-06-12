// version-sources.ts — discover available upstream versions for a service.
//
// The only network-facing part of `stack-cli update`. Each upstream kind has a
// thin adapter (listVersions) returning candidate tags/refs; the pure helpers
// (inferSource / parse* / pickCandidates) are unit-tested, the I/O is verified
// live. Adapters fail SOFT — a discovery error returns [] so `info`/`update`
// never blocks on a flaky registry.
import { $ } from 'zx'

export type SourceKind = 'dockerhub' | 'ghcr' | 'github' | 'npm' | 'nodejs' | 'unknown'

// Infer the upstream kind from an images.repo / source.repo string.
export const inferSource = (repo: string): SourceKind => {
  if (!repo) return 'unknown'
  if (/github\.com/.test(repo)) return 'github'
  if (/^ghcr\.io\//.test(repo)) return 'ghcr'
  if (/registry\.npmjs\.org|^npm:/.test(repo)) return 'npm'
  if (/nodejs\.org/.test(repo)) return 'nodejs'
  if (/^(docker\.io|registry-1\.docker\.io|index\.docker\.io)\//.test(repo)) return 'dockerhub'
  // Bare `name` or `org/name` with no registry host => Docker Hub.
  if (!/\.[a-z]{2,}\//i.test(repo)) return 'dockerhub'
  return 'unknown'
}

// ---- response parsers (pure) ---------------------------------------------
const names = (arr: unknown): string[] =>
  Array.isArray(arr)
    ? arr
        .map((x) =>
          x && typeof x === 'object' ? String((x as { name?: unknown }).name ?? '') : '',
        )
        .filter(Boolean)
    : []

export const parseDockerHubTags = (json: unknown): string[] =>
  json && typeof json === 'object' ? names((json as { results?: unknown }).results) : []

export const parseGhcrTags = (json: unknown): string[] => {
  if (!json || typeof json !== 'object') return []
  const t = (json as { tags?: unknown }).tags
  return Array.isArray(t) ? t.map(String).filter(Boolean) : []
}

export const parseGitHubTags = (json: unknown): string[] => names(json)

// ---- candidate selection (pure) ------------------------------------------
type SortKind = 'semver' | 'date'

const semverParts = (v: string): { rel: number[]; pre: string | null } => {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-.]?(.*))?$/)
  if (!m) return { rel: [0, 0, 0], pre: v }
  return { rel: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4] : null }
}

// Compare descending (newest first).
const cmpSemverDesc = (a: string, b: string): number => {
  const pa = semverParts(a)
  const pb = semverParts(b)
  for (let i = 0; i < 3; i++) if (pa.rel[i] !== pb.rel[i]) return pb.rel[i] - pa.rel[i]
  // A release (no pre) outranks a prerelease of the same x.y.z.
  if (pa.pre === null && pb.pre !== null) return -1
  if (pa.pre !== null && pb.pre === null) return 1
  if (pa.pre && pb.pre) return pb.pre.localeCompare(pa.pre)
  return 0
}

// Build a "same shape" channel regex from the currently-pinned version: numeric
// runs become \d+, hash-like runs become [0-9a-f]+, everything else is literal.
// So `v7.1.69` tracks `^v\d+\.\d+\.\d+$` and `v1.3.0-alpha.1` tracks
// `^v\d+\.\d+\.\d+-alpha\.\d+$`. The default when no `update:` block overrides it.
export const channelFromVersion = (v: string): RegExp => {
  let out = ''
  let i = 0
  while (i < v.length) {
    const rest = v.slice(i)
    const hash = rest.match(/^[0-9a-f]{7,}/i)
    if (hash && /\d/.test(hash[0]) && /[a-f]/i.test(hash[0])) {
      out += '[0-9a-f]+'
      i += hash[0].length
      continue
    }
    const digits = rest.match(/^\d+/)
    if (digits) {
      out += '\\d+'
      i += digits[0].length
      continue
    }
    out += v[i].replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
    i++
  }
  return new RegExp(`^${out}$`)
}

export const pickCandidates = (
  tags: string[],
  opts: { channel: RegExp; sort: SortKind },
): string[] => {
  const seen = new Set<string>()
  const filtered = tags.filter((t) => {
    if (!opts.channel.test(t)) return false
    if (seen.has(t)) return false
    seen.add(t)
    return true
  })
  if (opts.sort === 'date') return filtered.sort((a, b) => b.localeCompare(a))
  return filtered.sort(cmpSemverDesc)
}

// ---- I/O adapters --------------------------------------------------------
const safeJson = async (url: string, headers?: Record<string, string>): Promise<unknown> => {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 8000)
  try {
    const r = await fetch(url, { signal: ac.signal, headers })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

const dockerHubPath = (repo: string): string => {
  const bare = repo.replace(/^(docker\.io|registry-1\.docker\.io|index\.docker\.io)\//, '')
  return bare.includes('/') ? bare : `library/${bare}`
}

const listDockerHub = async (repo: string): Promise<string[]> =>
  parseDockerHubTags(
    await safeJson(
      `https://hub.docker.com/v2/repositories/${dockerHubPath(repo)}/tags?page_size=100&ordering=last_updated`,
    ),
  )

const listGhcr = async (repo: string): Promise<string[]> => {
  const name = repo.replace(/^ghcr\.io\//, '')
  // GHCR requires a (anonymous) bearer token even for public repos.
  const tok = (await safeJson(`https://ghcr.io/token?scope=repository:${name}:pull`)) as {
    token?: string
  } | null
  if (!tok?.token) return []
  const headers = { Authorization: `Bearer ${tok.token}` }
  // tags/list returns at most `n` tags UNSORTED; follow RFC5988 `Link: rel=next`
  // so big repos (litellm, agentgateway) surface their newest tags. Capped.
  const all: string[] = []
  let url: string | null = `https://ghcr.io/v2/${name}/tags/list?n=200`
  for (let page = 0; page < 25 && url; page++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 8000)
    try {
      const r = await fetch(url, { headers, signal: ac.signal })
      if (!r.ok) break
      all.push(...parseGhcrTags(await r.json()))
      const next = r.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)
      url = next ? new URL(next[1], 'https://ghcr.io').toString() : null
    } catch {
      break
    } finally {
      clearTimeout(t)
    }
  }
  return all
}

const ghPath = (repo: string): string =>
  repo
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')

const listGitHub = async (repo: string): Promise<string[]> => {
  $.verbose = false
  try {
    const r = await $`gh api ${`repos/${ghPath(repo)}/tags`} --paginate -q ${'.[].name'}`
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

// List available versions for a repo, dispatching on inferred source. Soft-fail
// (returns []). npm/nodejs are deferred (return []).
export const listVersions = async (repo: string): Promise<string[]> => {
  switch (inferSource(repo)) {
    case 'dockerhub':
      return listDockerHub(repo)
    case 'ghcr':
      return listGhcr(repo)
    case 'github':
      return listGitHub(repo)
    default:
      return []
  }
}
