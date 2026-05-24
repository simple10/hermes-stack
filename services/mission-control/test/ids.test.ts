import { describe, it, expect } from 'vitest';
import { makeId } from '../src/ids.ts';

describe('makeId', () => {
  it('uses the correct prefix for task', () => {
    expect(makeId('task')).toMatch(/^t_[0-9a-f]{24}$/);
  });

  it('uses the correct prefix for agent', () => {
    expect(makeId('agent')).toMatch(/^agt_[0-9a-f]{24}$/);
  });

  it('uses the correct prefix for connector', () => {
    expect(makeId('connector')).toMatch(/^cnn_[0-9a-f]{24}$/);
  });

  it('uses the correct prefix for project', () => {
    expect(makeId('project')).toMatch(/^prj_[0-9a-f]{24}$/);
  });

  it('uses the correct prefix for comment', () => {
    expect(makeId('comment')).toMatch(/^cmt_[0-9a-f]{24}$/);
  });

  it('uses the correct prefix for event', () => {
    expect(makeId('event')).toMatch(/^evt_[0-9a-f]{24}$/);
  });

  it('uses the correct prefix for externalRef', () => {
    expect(makeId('externalRef')).toMatch(/^xrf_[0-9a-f]{24}$/);
  });

  it('uses the correct prefix for org', () => {
    expect(makeId('org')).toMatch(/^org_[0-9a-f]{24}$/);
  });

  it('uses the correct prefix for user', () => {
    expect(makeId('user')).toMatch(/^usr_[0-9a-f]{24}$/);
  });

  it('uses the correct prefix for apiKey', () => {
    expect(makeId('apiKey')).toMatch(/^apk_[0-9a-f]{24}$/);
  });

  it('falls back to the raw kind as prefix for unknown kinds', () => {
    expect(makeId('custom')).toMatch(/^custom_[0-9a-f]{24}$/);
  });

  it('generates unique IDs on successive calls', () => {
    const ids = Array.from({ length: 100 }, () => makeId('task'));
    const unique = new Set(ids);
    expect(unique.size).toBe(100);
  });
});
