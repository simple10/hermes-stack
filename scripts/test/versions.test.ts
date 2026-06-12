// versions.test.ts — human-readable version derivation for info/start display.
//
// Rule: show a version TAG where possible; for digest-only pins fall back to
// the requested tag from .generated.env, else a short digest.
import { describe, expect, test } from 'vitest'
import { parseImageRef, humanVersion, requestedKey } from '../lib/versions.ts'
import { formatServiceLines } from '../lib/render-health.ts'
import type { ServiceHealth } from '../lib/health.ts'

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const svcHealth = (over: Partial<ServiceHealth>): ServiceHealth => ({
  service: 'phoenix',
  containerName: 'aitools-phoenix-1',
  image: 'arizephoenix/phoenix@sha256:abc',
  status: 'Up 2 minutes (healthy)',
  run: 'running',
  health: 'healthy',
  enabled: true,
  ...over,
})

describe('requestedKey (.generated.env lookup name)', () => {
  test('image knob -> <IMAGE>_IMAGE_REQUESTED', () => {
    expect(
      requestedKey(
        { key: 'PHOENIX_VERSION', default: '', repo: '', kind: 'image', imageName: 'PHOENIX' },
        'phoenix',
      ),
    ).toBe('PHOENIX_IMAGE_REQUESTED')
  })

  test('source knob -> <SVC_UC>_SOURCE_REQUESTED', () => {
    expect(
      requestedKey(
        { key: 'HONCHO_UI_VERSION', default: '', repo: '', kind: 'source' },
        'honcho-ui',
      ),
    ).toBe('HONCHO_UI_SOURCE_REQUESTED')
  })
})

describe('formatServiceLines version column', () => {
  test('shows the version when present', () => {
    const [line] = formatServiceLines([svcHealth({ version: 'version-16.3.0' })])
    expect(strip(line)).toContain('version-16.3.0')
  })

  test('omits a version column when absent (no crash)', () => {
    const [line] = formatServiceLines([svcHealth({ version: undefined })])
    expect(strip(line)).toContain('phoenix')
  })

  test('flags an out-of-band unreachable service', () => {
    const [line] = formatServiceLines([svcHealth({ reachable: false })])
    expect(strip(line)).toContain('unreachable')
  })

  test('shows reachable when the container has no docker healthcheck', () => {
    const [line] = formatServiceLines([svcHealth({ health: 'none', reachable: true })])
    expect(strip(line)).toContain('reachable')
  })

  test('does not add a reachability token when probe agrees with docker health', () => {
    const [line] = formatServiceLines([svcHealth({ health: 'healthy', reachable: true })])
    expect(strip(line)).not.toContain('reachable')
  })
})

describe('parseImageRef', () => {
  test('repo:tag', () => {
    expect(parseImageRef('arizephoenix/phoenix:version-16.3.0')).toMatchObject({
      repo: 'arizephoenix/phoenix',
      tag: 'version-16.3.0',
    })
  })

  test('repo@digest', () => {
    expect(
      parseImageRef('ghcr.io/outsourc-e/hermes-workspace@sha256:2d2ba9aa5b12ffff'),
    ).toMatchObject({
      repo: 'ghcr.io/outsourc-e/hermes-workspace',
      digest: 'sha256:2d2ba9aa5b12ffff',
    })
  })

  test('host:port/repo:tag does not mistake the registry port for a tag', () => {
    expect(parseImageRef('localhost:5000/foo/bar:1.2.3')).toMatchObject({
      repo: 'localhost:5000/foo/bar',
      tag: '1.2.3',
    })
  })

  test('host:port/repo with no tag', () => {
    const r = parseImageRef('localhost:5000/foo/bar')
    expect(r.repo).toBe('localhost:5000/foo/bar')
    expect(r.tag).toBeUndefined()
  })

  test('empty', () => {
    expect(parseImageRef('')).toEqual({ repo: '' })
  })
})

describe('humanVersion', () => {
  test('prefers the running image tag', () => {
    expect(humanVersion('arizephoenix/phoenix:version-16.3.0')).toBe('version-16.3.0')
  })

  test('digest-pinned image falls back to the requested tag', () => {
    expect(humanVersion('arizephoenix/phoenix@sha256:91bb10c1217cd1fc0b', 'version-16.3.0')).toBe(
      'version-16.3.0',
    )
  })

  test('digest-only (requested is also a digest) shows a short digest', () => {
    expect(
      humanVersion(
        'ghcr.io/outsourc-e/hermes-workspace@sha256:2d2ba9aa5b1230766267322817e8e5',
        'sha256:2d2ba9aa5b1230766267322817e8e5',
      ),
    ).toBe('2d2ba9aa5b12')
  })

  test('no image, no requested -> empty', () => {
    expect(humanVersion('', '')).toBe('')
  })

  test('source git sha requested -> short sha', () => {
    expect(humanVersion('', 'e490d911fcb27ee193558fd9a28856cde2057665')).toBe('e490d911fcb2')
  })
})
