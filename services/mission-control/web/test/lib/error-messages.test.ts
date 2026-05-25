import { describe, it, expect } from 'vitest';
import { ApiError } from '@/lib/api';
import { messageFor } from '@/lib/error-messages';

describe('messageFor', () => {
  it('maps known codes to friendly strings', () => {
    expect(messageFor(new ApiError(401, 'auth.invalid'))).toMatch(/sign in/i);
    expect(messageFor(new ApiError(403, 'auth.role_insufficient'))).toMatch(/permission/i);
    expect(messageFor(new ApiError(409, 'agent.has_active_tasks'))).toMatch(/active tasks/i);
    expect(messageFor(new ApiError(409, 'connector.has_active_refs'))).toMatch(/external refs/i);
    expect(messageFor(new ApiError(409, 'task.invalid_transition'))).toMatch(/status change/i);
    expect(messageFor(new ApiError(503, 'pool.binding_missing'))).toMatch(/unavailable/i);
  });

  it('appends request_id when present', () => {
    const msg = messageFor(new ApiError(401, 'auth.invalid', undefined, 'req_abc'));
    // auth.invalid is one of the codes that doesn't append; pick a default-fallback code
    const fallback = messageFor(new ApiError(500, 'weird', undefined, 'req_xyz'));
    expect(fallback).toContain('weird');
    expect(fallback).toContain('req_xyz');
    expect(msg).toMatch(/sign in/i);
  });

  it('falls back to ApiError.code for unknown codes', () => {
    expect(messageFor(new ApiError(500, 'novel.error.code'))).toContain('novel.error.code');
  });

  it('uses Error message for non-ApiError errors', () => {
    expect(messageFor(new Error('boom'))).toBe('boom');
  });

  it('returns generic message for non-Error values', () => {
    expect(messageFor('string thrown')).toMatch(/wrong/i);
    expect(messageFor(null)).toMatch(/wrong/i);
  });
});
