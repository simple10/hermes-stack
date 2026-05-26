/**
 * Integration tests for GET /api/v1/events.
 *
 * Coverage:
 *   - returns {events, next_cursor} envelope
 *   - since acts as exclusive lower bound
 *   - kinds filter (comma-separated resource_type values)
 *   - rejects agent role with 403
 *   - cross-org isolation: events in one org are not visible to another
 *   - empty stream returns {events: [], next_cursor: null}
 */
import { describe, it, expect, beforeAll, inject } from 'vitest'
import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from '@cloudflare/vitest-pool-workers'
import app from '../../src/index.ts'
import { createOrgFixture } from '../helpers/orgs.ts'

const ADMIN_TOKEN = 'events-route-test-token'
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any

// Org A — has activity (a project + a task + a comment).
let patA = ''
let projectIdA = ''
let taskIdA = ''
let agentKeyA = ''

// Org B — empty (for isolation test).
let patB = ''

beforeAll(async () => {
  await applyD1Migrations(env.DB as D1Database, inject('d1Migrations') as D1Migration[])

  // Org A setup.
  const fixA = await createOrgFixture(env.DB as D1Database, 'Events Test A', 'events-test-a')
  patA = fixA.pat

  const p = await app.fetch(
    new Request('http://x/api/v1/projects', {
      method: 'POST',
      headers: { Authorization: `Bearer ${patA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', slug: 'events-p' }),
    }),
    TEST_ENV,
  )
  projectIdA = ((await p.json()) as { project: { id: string } }).project.id

  const a = await app.fetch(
    new Request('http://x/api/v1/agents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${patA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'agent-events-a', kind: 'hermes' }),
    }),
    TEST_ENV,
  )
  const ab = (await a.json()) as { agent: { id: string }; key: string }
  agentKeyA = ab.key

  const t = await app.fetch(
    new Request('http://x/api/v1/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${patA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectIdA, title: 't-for-events' }),
    }),
    TEST_ENV,
  )
  taskIdA = ((await t.json()) as { task: { id: string } }).task.id

  await app.fetch(
    new Request(`http://x/api/v1/tasks/${taskIdA}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${patA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'first comment' }),
    }),
    TEST_ENV,
  )

  // Org B — separate org with no activity.
  const fixB = await createOrgFixture(env.DB as D1Database, 'Events Test B', 'events-test-b')
  patB = fixB.pat
})

describe('GET /api/v1/events', () => {
  it('returns {events, next_cursor} envelope with rows after setup', async () => {
    const res = await app.fetch(
      new Request('http://x/api/v1/events?since=0&limit=100', {
        headers: { Authorization: `Bearer ${patA}` },
      }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: any[]; next_cursor: string | null }
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events.length).toBeGreaterThan(0)
    expect('next_cursor' in body).toBe(true)
    expect(body.events[0]).toHaveProperty('id')
    expect(body.events[0]).toHaveProperty('resource_type')
    expect(body.events[0]).toHaveProperty('kind')
    expect(body.events[0]).toHaveProperty('payload')
  })

  it('respects since as exclusive lower bound', async () => {
    const all = (await (
      await app.fetch(
        new Request('http://x/api/v1/events?since=0&limit=100', {
          headers: { Authorization: `Bearer ${patA}` },
        }),
        TEST_ENV,
      )
    ).json()) as { events: any[] }
    expect(all.events.length).toBeGreaterThan(1)
    const mid = all.events[Math.floor(all.events.length / 2)].id
    const after = (await (
      await app.fetch(
        new Request(`http://x/api/v1/events?since=${mid}&limit=100`, {
          headers: { Authorization: `Bearer ${patA}` },
        }),
        TEST_ENV,
      )
    ).json()) as { events: any[] }
    expect(after.events.every((e: any) => e.id > mid)).toBe(true)
  })

  it('filters by kinds (resource_type)', async () => {
    const tasksOnly = (await (
      await app.fetch(
        new Request('http://x/api/v1/events?since=0&kinds=task&limit=100', {
          headers: { Authorization: `Bearer ${patA}` },
        }),
        TEST_ENV,
      )
    ).json()) as { events: any[] }
    expect(tasksOnly.events.length).toBeGreaterThan(0)
    expect(tasksOnly.events.every((e: any) => e.resource_type === 'task')).toBe(true)

    const commentsOnly = (await (
      await app.fetch(
        new Request('http://x/api/v1/events?since=0&kinds=comment&limit=100', {
          headers: { Authorization: `Bearer ${patA}` },
        }),
        TEST_ENV,
      )
    ).json()) as { events: any[] }
    expect(commentsOnly.events.every((e: any) => e.resource_type === 'comment')).toBe(true)
  })

  it('rejects agent role with 403', async () => {
    const res = await app.fetch(
      new Request('http://x/api/v1/events?since=0&limit=10', {
        headers: { Authorization: `Bearer ${agentKeyA}` },
      }),
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('isolation: org B sees only its own (empty) events', async () => {
    const res = await app.fetch(
      new Request('http://x/api/v1/events?since=0&limit=100', {
        headers: { Authorization: `Bearer ${patB}` },
      }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: any[]; next_cursor: string | null }
    expect(body.events.length).toBe(0)
    expect(body.next_cursor).toBe(null)
  })

  it('paginates within a since-window via cursor', async () => {
    // Force pagination by requesting a tiny limit.
    const page1 = (await (
      await app.fetch(
        new Request('http://x/api/v1/events?since=0&limit=2', {
          headers: { Authorization: `Bearer ${patA}` },
        }),
        TEST_ENV,
      )
    ).json()) as { events: any[]; next_cursor: string | null }
    expect(page1.events.length).toBe(2)
    expect(page1.next_cursor).not.toBeNull()

    const page2 = (await (
      await app.fetch(
        new Request(`http://x/api/v1/events?since=0&limit=2&cursor=${page1.next_cursor}`, {
          headers: { Authorization: `Bearer ${patA}` },
        }),
        TEST_ENV,
      )
    ).json()) as { events: any[]; next_cursor: string | null }
    expect(page2.events.length).toBeGreaterThan(0)
    expect(page2.events.every((e: any) => e.id > Number(page1.next_cursor))).toBe(true)
  })

  it('returns payload as a parsed object (not a JSON string)', async () => {
    const body = (await (
      await app.fetch(
        new Request('http://x/api/v1/events?since=0&kinds=task&limit=100', {
          headers: { Authorization: `Bearer ${patA}` },
        }),
        TEST_ENV,
      )
    ).json()) as { events: any[] }
    const taskCreated = body.events.find((e: any) => e.kind === 'task.created')
    expect(taskCreated).toBeDefined()
    expect(typeof taskCreated.payload).toBe('object')
    // task.created carries the full task row in payload
    expect(taskCreated.payload).toHaveProperty('task')
  })
})
