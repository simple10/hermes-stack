// load-bearing.test.ts — which services are depended on via service_healthy
// (their in-container healthcheck is load-bearing: if it breaks, dependents
// hang at startup).
import { describe, expect, test, vi } from 'vitest'

const fresh = async (): Promise<typeof import('../lib/load-bearing.ts')> => {
  vi.resetModules()
  const { _resetServiceCache } = await import('../lib/services.ts')
  _resetServiceCache()
  return import('../lib/load-bearing.ts')
}

describe('loadBearingServices', () => {
  test('includes substrate depended on via condition: service_healthy', async () => {
    const { loadBearingServices } = await fresh()
    const lb = loadBearingServices()
    // honcho/hindsight/firecrawl/phoenix-provision gate on these being healthy.
    expect(lb.has('pg')).toBe(true)
    expect(lb.has('redis')).toBe(true)
    expect(lb.has('litellm')).toBe(true)
  })

  test('a leaf service nobody waits on is not load-bearing', async () => {
    const { loadBearingServices } = await fresh()
    expect(loadBearingServices().has('cliproxyapi')).toBe(false)
  })
})
