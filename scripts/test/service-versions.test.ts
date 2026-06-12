// service-versions.test.ts — version-knob discovery + owner-map registration.
//
// serviceVersionKnobs() derives the *_VERSION knob(s) for a service from its
// images:/source: blocks, and stackEnvOwnerMap() must register those knobs so
// stackGet/stackUpsert treat them as block-owned (the fix that lets digest-
// pinned services like litellm surface an editable LITELLM_VERSION knob).
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const fresh = async (): Promise<typeof import('../lib/services.ts')> => {
  vi.resetModules()
  const services = await import('../lib/services.ts')
  services._resetServiceCache()
  return services
}

// Stack harness: temp .stack dir, fresh module graph, reset owner-map cache.
const stackSetup = async (): Promise<{
  STACK_ENV: string
  stack: typeof import('../lib/stack.ts')
}> => {
  vi.resetModules()
  const dir = mkdtempSync(resolve(tmpdir(), 'svcver-'))
  process.env.HERMES_STACK_DIR_OVERRIDE = dir
  const paths = await import('../lib/paths.ts')
  const stack = await import('../lib/stack.ts')
  const { _resetServiceCache } = await import('../lib/services.ts')
  _resetServiceCache()
  return { STACK_ENV: paths.STACK_ENV, stack }
}

beforeEach(() => {
  delete process.env.HERMES_STACK_DIR_OVERRIDE
})

describe('serviceVersionKnobs', () => {
  test('image service yields one <NAME>_VERSION knob', async () => {
    const { serviceVersionKnobs } = await fresh()
    const knobs = serviceVersionKnobs('phoenix')
    expect(knobs).toHaveLength(1)
    expect(knobs[0]).toMatchObject({
      key: 'PHOENIX_VERSION',
      kind: 'image',
      imageName: 'PHOENIX',
      repo: 'arizephoenix/phoenix',
    })
    expect(knobs[0].default.length).toBeGreaterThan(0)
  })

  test('multi-image service yields one knob per image', async () => {
    const { serviceVersionKnobs } = await fresh()
    const keys = serviceVersionKnobs('firecrawl').map((k) => k.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'FIRECRAWL_API_VERSION',
        'FIRECRAWL_PLAYWRIGHT_VERSION',
        'FIRECRAWL_POSTGRES_VERSION',
      ]),
    )
  })

  test('source service yields a <SVC_UC>_VERSION source knob', async () => {
    const { serviceVersionKnobs } = await fresh()
    const knobs = serviceVersionKnobs('honcho-ui')
    expect(knobs).toHaveLength(1)
    expect(knobs[0]).toMatchObject({ key: 'HONCHO_UI_VERSION', kind: 'source' })
    expect(knobs[0].repo).toContain('github.com')
  })

  test('service with neither images nor source yields no knobs', async () => {
    const { serviceVersionKnobs } = await fresh()
    expect(serviceVersionKnobs('localhost-proxy')).toEqual([])
  })
})

describe('serviceEnvSchema seeds version knobs', () => {
  const occurrences = (body: string, key: string): number =>
    (body.match(new RegExp(`^${key}=`, 'gm')) ?? []).length

  test('digest service gains its knob and keeps its env: keys', async () => {
    const { serviceEnvSchema } = await fresh()
    const schema = serviceEnvSchema('litellm')
    expect(occurrences(schema, 'LITELLM_VERSION')).toBe(1)
    expect(schema).toMatch(/^LITELLM_MASTER_KEY=/m) // original env: line preserved
  })

  test('hand-declared knob is not duplicated', async () => {
    const { serviceEnvSchema } = await fresh()
    // phoenix declares PHOENIX_VERSION in its env: block today
    expect(occurrences(serviceEnvSchema('phoenix'), 'PHOENIX_VERSION')).toBe(1)
  })

  test('multi-image service seeds every knob', async () => {
    const { serviceEnvSchema } = await fresh()
    const schema = serviceEnvSchema('firecrawl')
    expect(occurrences(schema, 'FIRECRAWL_API_VERSION')).toBe(1)
    expect(occurrences(schema, 'FIRECRAWL_PLAYWRIGHT_VERSION')).toBe(1)
    expect(occurrences(schema, 'FIRECRAWL_POSTGRES_VERSION')).toBe(1)
  })

  test('service with no knobs returns its env: body unchanged', async () => {
    const { serviceEnvSchema, loadService } = await fresh()
    expect(serviceEnvSchema('redis')).toBe(loadService('redis')!.env)
  })
})

describe('enable seeds the knob into .stack/.env (integration)', () => {
  test('enabling a digest-pinned service writes its *_VERSION knob in-block', async () => {
    const { STACK_ENV, stack } = await stackSetup()
    stack.enableService('litellm')
    const body = readFileSync(STACK_ENV, 'utf8')
    // The knob lands inside litellm's block and is readable block-aware.
    expect(body).toMatch(/#>--- litellm ---[\s\S]*LITELLM_VERSION=[\s\S]*#<--- litellm ---/)
    expect(stack.stackGet('LITELLM_VERSION').length).toBeGreaterThan(0)
  })
})

describe('stackEnvOwnerMap registers version knobs', () => {
  test('digest-pinned service knob is block-owned (regression: litellm)', async () => {
    const { stackEnvOwnerMap } = await fresh()
    // LITELLM_VERSION is NOT declared in litellm's env: block — it must still
    // be owned by litellm via its images: declaration.
    expect(stackEnvOwnerMap().get('LITELLM_VERSION')).toBe('litellm')
  })

  test('source service knob is block-owned', async () => {
    const { stackEnvOwnerMap } = await fresh()
    expect(stackEnvOwnerMap().get('HONCHO_UI_VERSION')).toBe('honcho-ui')
  })
})
