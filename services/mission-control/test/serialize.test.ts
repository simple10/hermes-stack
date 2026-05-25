/**
 * Unit tests for serializeRow (src/db/helpers.ts).
 *
 * Verifies:
 *   - camelCase keys are converted to snake_case
 *   - known timestamp fields (integer ms) are converted to ISO strings
 *   - null timestamps remain null
 *   - known JSON string columns are parsed into objects
 *   - arrays of rows are recursively handled
 *   - nested objects are recursively converted
 *   - non-object types pass through unchanged
 */
import { describe, it, expect } from 'vitest'
import { serializeRow, serializeTimestamps } from '../src/db/helpers.ts'

describe('serializeRow — camelCase → snake_case', () => {
  it('converts a simple camelCase key', () => {
    const result = serializeRow({ orgId: 'org_123' })
    expect(result.org_id).toBe('org_123')
    expect(result.orgId).toBeUndefined()
  })

  it('converts multiple camelCase keys', () => {
    const result = serializeRow({
      agentId: 'agt_1',
      projectId: 'prj_1',
      createdByUserId: 'usr_1',
    })
    expect(result.agent_id).toBe('agt_1')
    expect(result.project_id).toBe('prj_1')
    expect(result.created_by_user_id).toBe('usr_1')
  })

  it('leaves non-camelCase keys unchanged', () => {
    const result = serializeRow({ id: 'abc', name: 'test', status: 'pending' })
    expect(result.id).toBe('abc')
    expect(result.name).toBe('test')
    expect(result.status).toBe('pending')
  })
})

describe('serializeRow — timestamp conversion', () => {
  it('converts integer ms timestamps to ISO strings', () => {
    const ts = 1716336000000 // 2024-05-21T16:00:00.000Z
    const result = serializeRow({ createdAt: ts })
    expect(result.created_at).toBe(new Date(ts).toISOString())
    expect(typeof result.created_at).toBe('string')
  })

  it('converts updatedAt, deletedAt, startedAt, completedAt', () => {
    const now = Date.now()
    const result = serializeRow({
      updatedAt: now,
      deletedAt: now,
      startedAt: now,
      completedAt: now,
    })
    expect(result.updated_at).toBe(new Date(now).toISOString())
    expect(result.deleted_at).toBe(new Date(now).toISOString())
    expect(result.started_at).toBe(new Date(now).toISOString())
    expect(result.completed_at).toBe(new Date(now).toISOString())
  })

  it('converts lastSeenAt, expiresAt, lastUsedAt, revokedAt', () => {
    const now = Date.now()
    const result = serializeRow({
      lastSeenAt: now,
      expiresAt: now,
      lastUsedAt: now,
      revokedAt: now,
    })
    expect(result.last_seen_at).toBe(new Date(now).toISOString())
    expect(result.expires_at).toBe(new Date(now).toISOString())
    expect(result.last_used_at).toBe(new Date(now).toISOString())
    expect(result.revoked_at).toBe(new Date(now).toISOString())
  })

  it('passes null timestamps through as null', () => {
    const result = serializeRow({ deletedAt: null, startedAt: null })
    expect(result.deleted_at).toBeNull()
    expect(result.started_at).toBeNull()
  })

  it('does not convert non-timestamp integer fields', () => {
    const result = serializeRow({ priority: 50, count: 100 })
    expect(result.priority).toBe(50)
    expect(result.count).toBe(100)
  })
})

describe('serializeRow — JSON column parsing', () => {
  it('parses metadata JSON string into object', () => {
    const result = serializeRow({ metadata: '{"foo":"bar","count":3}' })
    expect(typeof result.metadata).toBe('object')
    expect(result.metadata.foo).toBe('bar')
    expect(result.metadata.count).toBe(3)
  })

  it('parses payload JSON string into object', () => {
    const result = serializeRow({ payload: '{"from":"pending","to":"ready"}' })
    expect(result.payload.from).toBe('pending')
    expect(result.payload.to).toBe('ready')
  })

  it('parses permissions JSON string into object', () => {
    const result = serializeRow({ permissions: '["read","write"]' })
    expect(Array.isArray(result.permissions)).toBe(true)
    expect(result.permissions).toContain('read')
  })

  it('leaves un-parseable JSON strings unchanged', () => {
    const result = serializeRow({ metadata: 'not-valid-json{' })
    expect(result.metadata).toBe('not-valid-json{')
  })

  it('passes null metadata through as null', () => {
    const result = serializeRow({ metadata: null })
    expect(result.metadata).toBeNull()
  })
})

describe('serializeRow — recursive handling', () => {
  it('handles arrays of rows', () => {
    const rows = [
      { orgId: 'org_1', createdAt: 1716336000000 },
      { orgId: 'org_2', createdAt: 1716336001000 },
    ]
    const result = serializeRow(rows)
    expect(result[0].org_id).toBe('org_1')
    expect(typeof result[0].created_at).toBe('string')
    expect(result[1].org_id).toBe('org_2')
  })

  it('recursively converts nested objects', () => {
    const result = serializeRow({
      taskId: 't_1',
      agent: { agentId: 'agt_1', orgId: 'org_1' },
    })
    expect(result.task_id).toBe('t_1')
    expect(result.agent.agent_id).toBe('agt_1')
    expect(result.agent.org_id).toBe('org_1')
  })

  it('passes null through unchanged', () => {
    expect(serializeRow(null)).toBeNull()
  })

  it('passes undefined through unchanged', () => {
    expect(serializeRow(undefined)).toBeUndefined()
  })

  it('passes primitive strings through unchanged', () => {
    expect(serializeRow('hello' as any)).toBe('hello')
  })
})

describe('serializeTimestamps — backward compat alias', () => {
  it('is the same function as serializeRow', () => {
    expect(serializeTimestamps).toBe(serializeRow)
  })

  it('also converts camelCase keys', () => {
    const result = serializeTimestamps({ orgId: 'org_abc' })
    expect(result.org_id).toBe('org_abc')
  })
})
