import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { validateResponses } from '../../src/middleware/validate-responses.ts'

const devEnv = { DB_MODE: 'single' }
const prodEnv = { DB_MODE: 'split' }

describe('validateResponses', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('logs a warning when a response drifts from its schema (dev mode)', async () => {
    const app = new Hono()
    app.use('/api/v1/*', validateResponses)
    // AgentListResponse expects { agents: [...], next_cursor }; return garbage instead.
    app.get('/api/v1/agents', (c) => c.json({ bogus: true }))

    const res = await app.request('/api/v1/agents', {}, devEnv)
    expect(res.status).toBe(200)
    expect(warn).toHaveBeenCalledWith(
      '[validate-responses] schema drift',
      expect.objectContaining({ method: 'GET', path: '/api/v1/agents' }),
    )
  })

  it('does NOT log when the response matches its schema (dev mode)', async () => {
    const app = new Hono()
    app.use('/api/v1/*', validateResponses)
    app.get('/api/v1/agents', (c) => c.json({ agents: [], next_cursor: null }))

    const res = await app.request('/api/v1/agents', {}, devEnv)
    expect(res.status).toBe(200)
    expect(warn).not.toHaveBeenCalled()
  })

  it('no-ops in production mode (skips validation regardless of drift)', async () => {
    const app = new Hono()
    app.use('/api/v1/*', validateResponses)
    app.get('/api/v1/agents', (c) => c.json({ bogus: true })) // would drift in dev

    const res = await app.request('/api/v1/agents', {}, prodEnv)
    expect(res.status).toBe(200)
    expect(warn).not.toHaveBeenCalled()
  })

  it('skips non-200 responses', async () => {
    const app = new Hono()
    app.use('/api/v1/*', validateResponses)
    app.get('/api/v1/agents', (c) => c.json({ error: { code: 'x', message: 'y' } }, 500))

    const res = await app.request('/api/v1/agents', {}, devEnv)
    expect(res.status).toBe(500)
    expect(warn).not.toHaveBeenCalled()
  })

  it('skips routes not in the schema map', async () => {
    const app = new Hono()
    app.use('/api/v1/*', validateResponses)
    app.get('/api/v1/unknown', (c) => c.json({ anything: 'goes' }))

    const res = await app.request('/api/v1/unknown', {}, devEnv)
    expect(res.status).toBe(200)
    expect(warn).not.toHaveBeenCalled()
  })

  it(
    'matches bare ' + '/v1/' + ' paths too (so the middleware can be used at any mount)',
    async () => {
      // The middleware's regex is `(?:/api)?/v1/...` so both /api/v1/foo and
      // bare /v1/foo match. Strings split here so the post-Task-1.9 path-rewrite
      // sweep doesn't clobber the intentional bare-/v1/ reference.
      const bare = '/v1' + '/agents'
      const app = new Hono()
      app.use('*', validateResponses)
      app.get(bare, (c) => c.json({ also: 'wrong' }))

      const res = await app.request(bare, {}, devEnv)
      expect(res.status).toBe(200)
      expect(warn).toHaveBeenCalledWith(
        '[validate-responses] schema drift',
        expect.objectContaining({ path: bare }),
      )
    },
  )
})
