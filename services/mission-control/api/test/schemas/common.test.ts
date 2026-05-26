import { describe, it, expect } from 'vitest'
import { IdSlug, IsoTimestamp, TaskStatus, ErrorEnvelope } from '../../src/schemas/common.ts'

describe('common schemas', () => {
  it('IdSlug accepts a correctly prefixed id', () => {
    expect(IdSlug('t_').safeParse('t_abc123').success).toBe(true)
    expect(IdSlug('t_').safeParse('agt_abc').success).toBe(false)
  })

  it('IsoTimestamp accepts RFC3339 strings', () => {
    expect(IsoTimestamp.safeParse('2026-05-24T12:00:00.000Z').success).toBe(true)
    expect(IsoTimestamp.safeParse(1716552000000).success).toBe(false)
  })

  it('TaskStatus enumerates the master-spec statuses', () => {
    const valid = ['pending', 'ready', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']
    for (const s of valid) expect(TaskStatus.safeParse(s).success).toBe(true)
    expect(TaskStatus.safeParse('unknown').success).toBe(false)
  })

  it('ErrorEnvelope shape matches API error response', () => {
    const ok = ErrorEnvelope.safeParse({
      error: { code: 'task.not_found', message: 'x', details: {} },
    })
    expect(ok.success).toBe(true)
  })
})
