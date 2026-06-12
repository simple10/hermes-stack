// version-sources.test.ts — pure pieces of upstream version discovery:
// source inference, registry/API response parsing, and candidate selection
// (channel filter + sort). Network I/O (listVersions) is verified live, not here.
import { describe, expect, test } from 'vitest'
import {
  inferSource,
  parseDockerHubTags,
  parseGhcrTags,
  parseGitHubTags,
  pickCandidates,
  channelFromVersion,
} from '../lib/version-sources.ts'

describe('inferSource', () => {
  test('docker hub org repo', () => {
    expect(inferSource('arizephoenix/phoenix')).toBe('dockerhub')
  })
  test('docker hub official (no slash)', () => {
    expect(inferSource('redis')).toBe('dockerhub')
  })
  test('ghcr', () => {
    expect(inferSource('ghcr.io/berriai/litellm-database')).toBe('ghcr')
  })
  test('github source url', () => {
    expect(inferSource('https://github.com/plastic-labs/honcho')).toBe('github')
  })
})

describe('response parsers', () => {
  test('docker hub tags', () => {
    expect(parseDockerHubTags({ results: [{ name: 'v2' }, { name: 'v1' }] })).toEqual(['v2', 'v1'])
  })
  test('ghcr tags list', () => {
    expect(parseGhcrTags({ name: 'x', tags: ['v1', 'v2'] })).toEqual(['v1', 'v2'])
  })
  test('github tags', () => {
    expect(parseGitHubTags([{ name: 'v3' }, { name: 'v2' }])).toEqual(['v3', 'v2'])
  })
  test('parsers tolerate junk', () => {
    expect(parseDockerHubTags({})).toEqual([])
    expect(parseGhcrTags(null)).toEqual([])
    expect(parseGitHubTags('nope')).toEqual([])
  })
})

describe('pickCandidates (filter + sort)', () => {
  const tags = ['v1.2.0', 'v1.10.0', 'v1.3.0', 'v1.3.0-rc.1', 'latest', 'nightly', 'v1.2.0']

  test('stable channel: semver-desc, prereleases + junk excluded, deduped', () => {
    const got = pickCandidates(tags, { channel: /^v\d+\.\d+\.\d+$/, sort: 'semver' })
    expect(got).toEqual(['v1.10.0', 'v1.3.0', 'v1.2.0'])
  })

  test('beta channel: only prereleases', () => {
    const got = pickCandidates(tags, { channel: /-(rc|beta)\.\d+$/, sort: 'semver' })
    expect(got).toEqual(['v1.3.0-rc.1'])
  })

  test('date sort is lexical-desc', () => {
    const got = pickCandidates(['2026.5.1', '2026.5.17', '2026.4.9'], {
      channel: /^\d{4}\.\d+\.\d+$/,
      sort: 'date',
    })
    expect(got).toEqual(['2026.5.17', '2026.5.1', '2026.4.9'])
  })
})

describe('channelFromVersion (default "same shape" channel)', () => {
  const cases: [string, string[], string[]][] = [
    // version, should-match, should-not-match
    ['v7.1.69', ['v7.1.70', 'v7.2.0'], ['v7.1.69-rc.1', 'latest', '7.1.70']],
    ['version-16.3.0', ['version-17.4.0'], ['version-17.4.0-rc1', 'v17.4.0']],
    ['v1.3.0-alpha.1', ['v1.3.0-alpha.2', 'v1.4.0-alpha.1'], ['v1.3.0', 'v1.3.0-beta.1']],
    ['8.6.3', ['8.7.0'], ['v8.6.3', '8.6.3-alpine']],
    ['pg18', ['pg19'], ['18', 'pg18-bookworm']],
    ['2026.5.17-d7e8b7cd1', ['2026.6.1-abc1234'], ['2026.5.17', 'latest']],
  ]
  for (const [v, yes, no] of cases) {
    test(`${v} matches same-shape only`, () => {
      const re = channelFromVersion(v)
      for (const y of yes) expect(re.test(y), `${y} should match`).toBe(true)
      for (const n of no) expect(re.test(n), `${n} should NOT match`).toBe(false)
    })
  }
})
