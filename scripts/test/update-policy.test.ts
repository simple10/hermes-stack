// update-policy.test.ts — channel resolution (service.yaml update: block +
// user override) and target selection. Pure logic; no network.
import { describe, expect, test, vi } from 'vitest'

const fresh = async (): Promise<typeof import('../lib/update-policy.ts')> => {
  vi.resetModules()
  const { _resetServiceCache } = await import('../lib/services.ts')
  _resetServiceCache()
  return import('../lib/update-policy.ts')
}

describe('channelKey', () => {
  test('derives <SVC_UC>_UPDATE_CHANNEL', async () => {
    const { channelKey } = await fresh()
    expect(channelKey('cliproxyapi')).toBe('CLIPROXYAPI_UPDATE_CHANNEL')
    expect(channelKey('honcho-ui')).toBe('HONCHO_UI_UPDATE_CHANNEL')
  })
})

describe('resolveChannel', () => {
  test('uses the service update: block default channel', async () => {
    const { resolveChannel } = await fresh()
    const c = resolveChannel('cliproxyapi', 'v7.1.69')
    expect(c.name).toBe('stable')
    expect(c.regex.test('v7.1.70')).toBe(true)
    expect(c.regex.test('v7.1.70-rc.1')).toBe(false)
  })

  test('a user override selects a named channel', async () => {
    const { resolveChannel } = await fresh()
    // unknown override falls back to shape-derived; known would use the map.
    const c = resolveChannel('cliproxyapi', 'v7.1.69', 'stable')
    expect(c.name).toBe('stable')
  })

  test('no update: block -> derive a same-shape channel from current', async () => {
    const { resolveChannel } = await fresh()
    const c = resolveChannel('redis', '8.6.3')
    expect(c.regex.test('8.8.0')).toBe(true)
    expect(c.regex.test('v8.8.0')).toBe(false)
  })
})

describe('resolveTarget', () => {
  test('--to wins', async () => {
    const { resolveTarget } = await fresh()
    expect(resolveTarget('v1.0.0', ['v1.2.0'], 'v1.1.0')).toBe('v1.1.0')
  })
  test('newest candidate when newer than current', async () => {
    const { resolveTarget } = await fresh()
    expect(resolveTarget('v1.0.0', ['v1.2.0', 'v1.1.0'])).toBe('v1.2.0')
  })
  test('null when already newest', async () => {
    const { resolveTarget } = await fresh()
    expect(resolveTarget('v1.2.0', ['v1.2.0', 'v1.1.0'])).toBeNull()
  })
})
