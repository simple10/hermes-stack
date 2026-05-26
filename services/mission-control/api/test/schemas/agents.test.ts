import { describe, it, expect } from 'vitest'
import {
  AgentCreateBody,
  AgentPatchBody,
  AgentListQuery,
  Agent,
  AgentListResponse,
  AgentCreateResponse,
  AgentDetailResponse,
  AgentRotateKeyResponse,
  AgentDeleteResponse,
} from '../../src/schemas/agents.ts'

describe('agents schemas', () => {
  // -------------------------------------------------------------------------
  // Request bodies
  // -------------------------------------------------------------------------

  it('AgentCreateBody requires name + kind', () => {
    expect(AgentCreateBody.safeParse({ name: 'h1', kind: 'hermes' }).success).toBe(true)
    expect(AgentCreateBody.safeParse({ name: 'h1' }).success).toBe(false)
    expect(AgentCreateBody.safeParse({ kind: 'hermes' }).success).toBe(false)
    // description is optional (string only, not nullable per route schema)
    expect(
      AgentCreateBody.safeParse({ name: 'h1', kind: 'hermes', description: 'd' }).success,
    ).toBe(true)
  })

  it('AgentCreateBody enforces name/kind length limits', () => {
    expect(AgentCreateBody.safeParse({ name: '', kind: 'hermes' }).success).toBe(false)
    expect(AgentCreateBody.safeParse({ name: 'x'.repeat(101), kind: 'hermes' }).success).toBe(false)
    expect(AgentCreateBody.safeParse({ name: 'h1', kind: 'x'.repeat(51) }).success).toBe(false)
  })

  it('AgentPatchBody all-optional and description is nullable', () => {
    expect(AgentPatchBody.safeParse({}).success).toBe(true)
    expect(AgentPatchBody.safeParse({ name: 'new' }).success).toBe(true)
    expect(AgentPatchBody.safeParse({ name: 'new', description: null }).success).toBe(true)
    expect(AgentPatchBody.safeParse({ description: 'updated' }).success).toBe(true)
  })

  it('AgentListQuery coerces limit and accepts optional cursor', () => {
    const r = AgentListQuery.safeParse({ limit: '25', cursor: 'abc' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.limit).toBe(25)
    expect(AgentListQuery.safeParse({}).success).toBe(true)
    expect(AgentListQuery.safeParse({ limit: '0' }).success).toBe(false)
    expect(AgentListQuery.safeParse({ limit: '101' }).success).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Response shapes — matched to the actual route handler output
  // -------------------------------------------------------------------------

  it('Agent matches the serializeTimestamps output of an agents row', () => {
    const r = Agent.safeParse({
      id: 'agt_x',
      org_id: 'org_x',
      name: 'h1',
      kind: 'hermes',
      description: null,
      last_seen_at: null,
      created_by_user_id: 'usr_x',
      created_at: '2026-05-24T12:00:00.000Z',
      updated_at: '2026-05-24T12:00:00.000Z',
      deleted_at: null,
      deleted_by_type: null,
      deleted_by_id: null,
    })
    expect(r.success).toBe(true)
  })

  it('Agent rejects an unprefixed id', () => {
    const r = Agent.safeParse({
      id: 'not_prefixed',
      org_id: 'org_x',
      name: 'h1',
      kind: 'hermes',
      description: null,
      last_seen_at: null,
      created_by_user_id: null,
      created_at: '2026-05-24T12:00:00.000Z',
      updated_at: '2026-05-24T12:00:00.000Z',
      deleted_at: null,
      deleted_by_type: null,
      deleted_by_id: null,
    })
    expect(r.success).toBe(false)
  })

  it('AgentListResponse uses { agents, next_cursor } per the handler', () => {
    // The handler returns the array under `agents`, NOT under `data`.
    expect('agents' in AgentListResponse.shape).toBe(true)
    expect('next_cursor' in AgentListResponse.shape).toBe(true)
    const r = AgentListResponse.safeParse({ agents: [], next_cursor: null })
    expect(r.success).toBe(true)
  })

  it('AgentCreateResponse wraps the agent and includes a raw key', () => {
    expect('agent' in AgentCreateResponse.shape).toBe(true)
    expect('key' in AgentCreateResponse.shape).toBe(true)
  })

  it('AgentDetailResponse wraps the agent under `agent`', () => {
    expect('agent' in AgentDetailResponse.shape).toBe(true)
  })

  it('AgentRotateKeyResponse returns { key, expires_old_at } (nullable timestamp)', () => {
    // The handler returns expires_old_at as an ISO string or null, NOT
    // grace_seconds. Match what the route actually emits.
    expect('key' in AgentRotateKeyResponse.shape).toBe(true)
    expect('expires_old_at' in AgentRotateKeyResponse.shape).toBe(true)
    expect(
      AgentRotateKeyResponse.safeParse({
        key: 'mcagt_xxx',
        expires_old_at: '2026-05-24T12:05:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      AgentRotateKeyResponse.safeParse({ key: 'mcagt_xxx', expires_old_at: null }).success,
    ).toBe(true)
  })

  it('AgentDeleteResponse is the empty object the handler returns', () => {
    expect(AgentDeleteResponse.safeParse({}).success).toBe(true)
  })
})
