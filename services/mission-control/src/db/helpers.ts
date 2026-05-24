/**
 * DB query helpers — shared predicates and row serialisers.
 *
 * active()             — Drizzle predicate for `WHERE deleted_at IS NULL`
 * isoOrNull()          — convert an integer ms timestamp to an ISO 8601 string
 * serializeTimestamps() — walk a DB row and convert known timestamp columns to ISO strings
 *
 * Convention: every read of a soft-deletable table passes the table object
 * through `active()` so the `WHERE deleted_at IS NULL` guard is impossible to
 * forget.  CI lint rule catches raw selects that bypass this helper.
 */

import { isNull } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// active()
// ---------------------------------------------------------------------------

/**
 * Returns a Drizzle `isNull` predicate for the table's `deletedAt` column.
 *
 * Usage:
 *   db.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), active(tasks)));
 */
export function active(t: { deletedAt: Parameters<typeof isNull>[0] }) {
  return isNull(t.deletedAt);
}

// ---------------------------------------------------------------------------
// isoOrNull()
// ---------------------------------------------------------------------------

/**
 * Convert an integer ms-since-epoch timestamp to an RFC 3339 ISO 8601 string,
 * or `null` if the value is null/undefined.
 *
 * Internal storage: INTEGER ms.  API responses: ISO string.
 */
export function isoOrNull(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// serializeTimestamps()
// ---------------------------------------------------------------------------

/** Timestamp column names present in pool-DB rows. */
const TIMESTAMP_COLS = new Set([
  'createdAt',
  'updatedAt',
  'deletedAt',
  'startedAt',
  'completedAt',
  'lastSeenAt',
  'expiresAt',
]);

/** JSON column names whose values should be parsed from a string to an object. */
const JSON_COLS = new Set(['metadata', 'payload']);

/**
 * Convert a raw DB row into an API-ready shape.
 *
 * - Known timestamp columns (INTEGER ms) are converted to ISO 8601 strings.
 * - Known JSON columns (`metadata`, `payload`) that hold a JSON string are
 *   parsed into objects.  If parsing fails the raw string is left unchanged.
 *
 * The function is generic so TypeScript propagates the row type through the
 * call site — callers don't need to re-annotate the return value.
 */
export function serializeTimestamps<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };

  for (const k of TIMESTAMP_COLS) {
    if (k in out && typeof out[k] === 'number') {
      out[k] = isoOrNull(out[k] as number);
    }
  }

  for (const k of JSON_COLS) {
    if (k in out && typeof out[k] === 'string') {
      try {
        out[k] = JSON.parse(out[k] as string);
      } catch {
        // leave as-is; the string might be non-JSON in edge cases
      }
    }
  }

  return out as T;
}
