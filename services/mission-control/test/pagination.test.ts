import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, clampLimit } from '../src/pagination.ts';

const SECRET = 'a'.repeat(32);

describe('cursor', () => {
  it('round-trips a valid cursor', async () => {
    const payload = { updatedAt: 1_000_000, id: 't_abc123', orgId: 'org_xyz' };
    const cursor = await encodeCursor(payload, SECRET);
    const decoded = await decodeCursor(cursor, SECRET);
    expect(decoded).toEqual(payload);
  });

  it('rejects a tampered cursor body', async () => {
    const cursor = await encodeCursor({ updatedAt: 1000, id: 't_x', orgId: 'org_a' }, SECRET);
    // Corrupt the last two characters of the cursor
    const tampered = cursor.slice(0, -2) + 'XX';
    expect(await decodeCursor(tampered, SECRET)).toBe(null);
  });

  it('rejects a cursor signed with the wrong secret', async () => {
    const cursor = await encodeCursor({ updatedAt: 1000, id: 't_x', orgId: 'org_a' }, SECRET);
    expect(await decodeCursor(cursor, 'b'.repeat(32))).toBe(null);
  });

  it('rejects a cursor with no dot separator', async () => {
    expect(await decodeCursor('nodothere', SECRET)).toBe(null);
  });

  it('rejects a cursor with invalid base64 body', async () => {
    // valid sig doesn't matter — bad body fails first
    expect(await decodeCursor('!!!.dGVzdA==', SECRET)).toBe(null);
  });
});

describe('clampLimit', () => {
  it('returns default for undefined', () => {
    expect(clampLimit(undefined)).toBe(50);
  });

  it('returns default for non-numeric string', () => {
    expect(clampLimit('abc')).toBe(50);
  });

  it('returns default for zero', () => {
    expect(clampLimit(0)).toBe(50);
  });

  it('returns default for negative', () => {
    expect(clampLimit(-5)).toBe(50);
  });

  it('clamps to max', () => {
    expect(clampLimit(200)).toBe(100);
  });

  it('passes through valid value', () => {
    expect(clampLimit(42)).toBe(42);
  });

  it('floors fractional values', () => {
    expect(clampLimit(99.9)).toBe(99);
  });

  it('respects custom dflt and max', () => {
    expect(clampLimit(undefined, 10, 25)).toBe(10);
    expect(clampLimit(30, 10, 25)).toBe(25);
  });
});
