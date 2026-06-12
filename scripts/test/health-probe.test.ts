// health-probe.test.ts — out-of-band health: service.yaml `health:` parsing,
// probe-spec resolution (HTTP path vs TCP default), and the HTTP prober.
import { describe, expect, test, vi, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'

const fresh = async (): Promise<{
  services: typeof import('../lib/services.ts')
  probe: typeof import('../lib/health-probe.ts')
}> => {
  vi.resetModules()
  const services = await import('../lib/services.ts')
  services._resetServiceCache()
  const probe = await import('../lib/health-probe.ts')
  return { services, probe }
}

describe('service.yaml health: parsing', () => {
  test('http service parses path + port', async () => {
    const { services } = await fresh()
    expect(services.loadService('cliproxyapi')!.health).toMatchObject({
      path: '/healthz',
      port: 8317,
    })
  })

  test('service without a health: block parses as null', async () => {
    const { services } = await fresh()
    expect(services.loadService('redis')!.health).toBeNull()
  })
})

describe('healthProbeSpec', () => {
  test('declared path -> HTTP probe at the orb-DNS url', async () => {
    const { probe } = await fresh()
    const spec = probe.healthProbeSpec('cliproxyapi')
    expect(spec).toMatchObject({ kind: 'http' })
    if (spec?.kind === 'http') {
      expect(spec.url).toMatch(/^http:\/\/cliproxyapi\..*\.orb\.local:8317\/healthz$/)
    }
  })

  test('datastore service with no health: defaults to a TCP probe on its port', async () => {
    const { probe } = await fresh()
    const spec = probe.healthProbeSpec('redis')
    expect(spec).toMatchObject({ kind: 'tcp', port: 6379 })
  })

  test('unknown service -> null', async () => {
    const { probe } = await fresh()
    expect(probe.healthProbeSpec('does-not-exist')).toBeNull()
  })
})

describe('probeOnce (HTTP)', () => {
  let server: Server | null = null
  afterEach(() => {
    server?.close()
    server = null
  })
  const listen = (handler: (set: (status: number) => void) => void): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((_req, res) => {
        let code = 200
        handler((c) => (code = c))
        res.statusCode = code
        res.end('ok')
      })
      server.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
    })

  test('2xx -> ok', async () => {
    const { probe } = await fresh()
    const port = await listen(() => {})
    expect(
      await probe.probeOnce({
        kind: 'http',
        url: `http://127.0.0.1:${port}/healthz`,
        expect: null,
      }),
    ).toBe(true)
  })

  test('500 -> fail', async () => {
    const { probe } = await fresh()
    const port = await listen((set) => set(500))
    expect(
      await probe.probeOnce({
        kind: 'http',
        url: `http://127.0.0.1:${port}/healthz`,
        expect: null,
      }),
    ).toBe(false)
  })

  test('connection refused -> fail', async () => {
    const { probe } = await fresh()
    // nothing listening on this port
    expect(
      await probe.probeOnce({ kind: 'http', url: 'http://127.0.0.1:1/healthz', expect: null }, 500),
    ).toBe(false)
  })
})
