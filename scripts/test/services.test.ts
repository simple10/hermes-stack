// services.test.ts — validate that every real services/*/service.yaml in
// the repo parses cleanly (yaml + provides) and the cascade is cycle-safe.
import { describe, expect, test } from 'vitest'
import { listServices, expandRequires } from '../lib/services.ts'
import { serviceEndpoints } from '../lib/endpoints.ts'

describe('services discovery', () => {
  test('at least the key services are present and well-formed', () => {
    const names = new Set(listServices().map((s) => s.name))
    for (const expected of [
      'pg',
      'redis',
      'litellm',
      'honcho',
      'honcho-ui',
      'cliproxyapi',
      'searxng',
      'camofox-browser',
      'localhost-proxy',
      'hermes',
    ]) {
      expect(names, `missing service: ${expected}`).toContain(expected)
    }
  })

  test('every service declares a runner and a (possibly empty) requires list', () => {
    for (const s of listServices()) {
      expect(['docker', 'vm']).toContain(s.runner)
      expect(Array.isArray(s.requires)).toBe(true)
    }
  })

  test('cascade closure for hermes leaves no duplicates and contains litellm + pg + redis', () => {
    const order = expandRequires(['hermes'])
    const set = new Set(order)
    expect(set.size).toBe(order.length)
    for (const dep of ['litellm', 'pg', 'redis', 'hermes']) {
      expect(set, `missing in closure: ${dep}`).toContain(dep)
    }
    // pg should come before litellm in leaf-first order:
    expect(order.indexOf('pg')).toBeLessThan(order.indexOf('litellm'))
    expect(order.indexOf('litellm')).toBeLessThan(order.indexOf('hermes'))
  })

  test('every provides endpoint has a finite port', () => {
    for (const s of listServices()) {
      for (const [name, ep] of Object.entries(s.provides)) {
        expect(Number.isFinite(ep.port), `${s.name}.provides.${name} port`).toBe(true)
      }
    }
  })

  test('endpoint URLs render with the right scheme/host convention', () => {
    // litellm: proto: https forces bare auto-HTTPS domain (port dropped) + path
    const litellm = serviceEndpoints('litellm').find((e) => e.name === 'api')
    expect(litellm?.url).toMatch(/^https:\/\/litellm\..+\.orb\.local\/v1$/)

    // honcho-ui: port 80 -> bare auto-HTTPS domain, no port
    const ui = serviceEndpoints('honcho-ui').find((e) => e.name === 'ui')
    expect(ui?.url).toMatch(/^https:\/\/honcho-ui\..+\.orb\.local$/)

    // honcho: service override -> honcho-api DNS name
    const honcho = serviceEndpoints('honcho').find((e) => e.name === 'api')
    expect(honcho?.url).toMatch(/^http:\/\/honcho-api\..+\.orb\.local:8000$/)

    // cliproxy dashboard: path is preserved
    const dash = serviceEndpoints('cliproxyapi').find((e) => e.name === 'dashboard')
    expect(dash?.url).toMatch(/:8317\/management\.html$/)

    // hermes: VM -> <project>-hermes.orb.local (no project DNS segment)
    const hermes = serviceEndpoints('hermes').find((e) => e.name === 'dashboard')
    expect(hermes?.isVm).toBe(true)
    expect(hermes?.url).toMatch(/^http:\/\/.+-hermes\.orb\.local:9119$/)
  })
})
