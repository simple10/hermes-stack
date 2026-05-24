/**
 * Task state machine — valid status transitions and terminal state set.
 *
 * State diagram (per spec):
 *   pending     → ready, cancelled, failed
 *   ready       → in_progress, cancelled, failed
 *   in_progress → blocked, completed, failed, cancelled
 *   blocked     → in_progress, failed, cancelled
 *   completed   → (terminal)
 *   failed      → (terminal)
 *   cancelled   → (terminal)
 *
 * Note: pending → in_progress is intentionally absent (must go through ready,
 * which requires agent assignment first).
 */

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Set of terminal statuses — no transitions out. */
export const TERMINAL = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);

/**
 * Allowed forward transitions from each status.
 * Keys are source statuses; values are sets of reachable target statuses.
 */
const TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  pending:     new Set(['ready', 'cancelled', 'failed']),
  ready:       new Set(['in_progress', 'cancelled', 'failed']),
  in_progress: new Set(['blocked', 'completed', 'failed', 'cancelled']),
  blocked:     new Set(['in_progress', 'failed', 'cancelled']),
  completed:   new Set(),
  failed:      new Set(),
  cancelled:   new Set(),
};

/**
 * Returns true when transitioning from `from` to `to` is permitted.
 *
 * Self-transitions (from === to) are always rejected — a PATCH that sets
 * status to the current status is a no-op and the caller should omit it;
 * we don't want to emit spurious status_changed events.
 */
export function validateTransition(from: string, to: string): boolean {
  if (from === to) return false;
  const allowed = TRANSITIONS[from as TaskStatus];
  if (!allowed) return false;
  return allowed.has(to as TaskStatus);
}
