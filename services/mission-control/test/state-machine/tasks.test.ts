/**
 * Exhaustive state machine transition matrix tests.
 *
 * 7 states × 7 states = 49 individual transition tests covering every
 * (from, to) pair — both allowed and rejected.
 *
 * Also tests:
 *   - Self-transitions always rejected (from === to)
 *   - TERMINAL set contains exactly { completed, failed, cancelled }
 *   - Invalid state strings return false
 */
import { describe, it, expect } from 'vitest';
import { validateTransition, TERMINAL } from '../../src/state-machine/tasks.ts';

const STATES = ['pending', 'ready', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled'] as const;

const ALLOWED: Record<string, string[]> = {
  pending:     ['ready', 'cancelled', 'failed'],
  ready:       ['in_progress', 'cancelled', 'failed'],
  in_progress: ['blocked', 'completed', 'failed', 'cancelled'],
  blocked:     ['in_progress', 'failed', 'cancelled'],
  completed:   [],
  failed:      [],
  cancelled:   [],
};

describe('Task state machine — full 7×7 transition matrix', () => {
  for (const from of STATES) {
    for (const to of STATES) {
      const allowed = ALLOWED[from]!.includes(to);
      it(`${from} → ${to}: ${allowed ? 'allowed' : 'rejected'}`, () => {
        expect(validateTransition(from, to)).toBe(allowed);
      });
    }
  }
});

describe('validateTransition — edge cases', () => {
  it('rejects self-transitions for every state', () => {
    for (const state of STATES) {
      expect(validateTransition(state, state)).toBe(false);
    }
  });

  it('rejects unknown source state', () => {
    expect(validateTransition('unknown_state', 'ready')).toBe(false);
  });

  it('rejects unknown target state from a real source', () => {
    expect(validateTransition('pending', 'nonexistent')).toBe(false);
  });

  it('rejects empty string for both from and to', () => {
    expect(validateTransition('', '')).toBe(false);
  });

  it('pending → in_progress is rejected (must go through ready first)', () => {
    expect(validateTransition('pending', 'in_progress')).toBe(false);
  });

  it('completed → pending is rejected (terminal states have no exit)', () => {
    expect(validateTransition('completed', 'pending')).toBe(false);
  });

  it('failed → ready is rejected', () => {
    expect(validateTransition('failed', 'ready')).toBe(false);
  });

  it('cancelled → in_progress is rejected', () => {
    expect(validateTransition('cancelled', 'in_progress')).toBe(false);
  });
});

describe('TERMINAL set', () => {
  it('contains exactly completed, failed, and cancelled', () => {
    expect(TERMINAL.has('completed')).toBe(true);
    expect(TERMINAL.has('failed')).toBe(true);
    expect(TERMINAL.has('cancelled')).toBe(true);
    expect(TERMINAL.size).toBe(3);
  });

  it('does not contain non-terminal states', () => {
    expect(TERMINAL.has('pending')).toBe(false);
    expect(TERMINAL.has('ready')).toBe(false);
    expect(TERMINAL.has('in_progress')).toBe(false);
    expect(TERMINAL.has('blocked')).toBe(false);
  });
});
