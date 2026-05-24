/**
 * DB query helpers — shared predicates and row serialisers.
 *
 * active()    — Drizzle predicate for `WHERE deleted_at IS NULL`
 * isoOrNull() — convert an integer ms timestamp to an ISO 8601 string
 * serializeRow()    — deep camelCase→snake_case + ISO timestamps + JSON column parsing
 * serializeTimestamps() — alias for serializeRow (backward compat)
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
// serializeRow() — deep camelCase→snake_case transformer
// ---------------------------------------------------------------------------

/**
 * Known timestamp column names (camelCase, as returned by Drizzle).
 * Values are INTEGER ms and must be converted to ISO strings.
 */
const TS_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'deletedAt',
  'startedAt',
  'completedAt',
  'lastSeenAt',
  'expiresAt',
  'lastUsedAt',
  'revokedAt',
]);

/**
 * Known JSON column names whose string values should be parsed into objects.
 */
const JSON_KEYS = new Set(['metadata', 'payload', 'permissions']);

/**
 * Convert a camelCase JavaScript identifier to snake_case.
 * e.g. "orgId" → "org_id", "createdAt" → "created_at"
 */
function camelToSnake(k: string): string {
  return k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
}

/**
 * Recursively convert a DB row (or array of rows) into an API-ready shape:
 *
 *  1. All object keys are converted from camelCase to snake_case.
 *  2. Known timestamp columns (INTEGER ms) are converted to ISO 8601 strings.
 *  3. Known JSON columns (`metadata`, `payload`, `permissions`) that hold a
 *     JSON string are parsed into objects.  Parsing failures leave the value
 *     as-is.
 *
 * Handles nested objects and arrays so that embedded sub-objects (e.g. the
 * `task` nested inside a task.created event payload) are also normalised.
 */
export function serializeRow<T>(row: T): any {
  if (row == null) return row;
  if (Array.isArray(row)) return row.map(serializeRow);
  if (typeof row !== 'object') return row;
  // Skip Date instances — they are not plain row objects.
  if (row instanceof Date) return row;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    const newK = camelToSnake(k);
    let newV = v;

    // Convert timestamp integers to ISO strings.
    if (TS_KEYS.has(k) && typeof v === 'number') {
      newV = new Date(v).toISOString();
    }
    // Parse JSON string columns into objects.
    if (JSON_KEYS.has(k) && typeof v === 'string') {
      try {
        newV = JSON.parse(v);
      } catch {
        // Leave as string if unparseable.
      }
    }
    // Recurse into nested objects/arrays (but not Dates).
    if (newV !== null && typeof newV === 'object' && !(newV instanceof Date)) {
      newV = serializeRow(newV);
    }
    out[newK] = newV;
  }
  return out;
}

/**
 * Alias kept for call-site backward compatibility.
 * All existing `serializeTimestamps(row)` calls now also get camelCase→snake_case.
 */
export const serializeTimestamps = serializeRow;
