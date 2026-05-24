/**
 * Layer-1 HTTP idempotency cache — Stripe-style Idempotency-Key header support.
 *
 * Records of (org_id, route, key) → (status, body) are stored in the
 * `idempotency_keys` table with a configurable TTL (default 24 h).
 *
 * Request body hash (SHA-256 hex) is stashed alongside the cached response so
 * a repeat call with the same key but different body returns 409 idempotency.conflict.
 */

import { and, eq } from 'drizzle-orm';
import { idempotencyKeys } from './db/pool.ts';
import type { PoolClient } from './db/client.ts';

// ---------------------------------------------------------------------------
// hashBody
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest of the canonical JSON representation of `body`.
 * Not strictly canonical (no key sorting) but deterministic for identical JS
 * values — good enough for dedup within a single request path.
 */
export async function hashBody(body: unknown): Promise<string> {
  const json = JSON.stringify(body);
  const data = new TextEncoder().encode(json);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// checkIdempotency
// ---------------------------------------------------------------------------

/** Possible outcomes of an idempotency key lookup. */
export type IdempotencyCheckResult =
  | { hit: true; cached: { status: number; body: unknown } }
  | { hit: false }
  | { hit: 'conflict' };

/**
 * Look up an idempotency key in the pool DB.
 *
 * Returns:
 *   { hit: false }         — key not found or expired (treat as miss)
 *   { hit: true, cached }  — key found + body hash matches → return the cached response
 *   { hit: 'conflict' }    — key found but body hash differs → 409
 */
export async function checkIdempotency(
  pool: PoolClient,
  orgId: string,
  route: string,
  key: string,
  requestBodyHash: string,
): Promise<IdempotencyCheckResult> {
  const row = await pool.query.idempotencyKeys.findFirst({
    where: and(
      eq(idempotencyKeys.orgId, orgId),
      eq(idempotencyKeys.route, route),
      eq(idempotencyKeys.key, key),
    ),
  });

  if (!row) return { hit: false };

  // Treat expired entries as a cache miss (the nightly purge hasn't run yet).
  if (row.expiresAt < Date.now()) return { hit: false };

  let parsed: { bodyHash: string; status: number; body: unknown };
  try {
    parsed = JSON.parse(row.responseBody) as { bodyHash: string; status: number; body: unknown };
  } catch {
    // Corrupt entry — treat as miss.
    return { hit: false };
  }

  if (parsed.bodyHash !== requestBodyHash) return { hit: 'conflict' };

  return { hit: true, cached: { status: parsed.status, body: parsed.body } };
}

// ---------------------------------------------------------------------------
// recordIdempotency
// ---------------------------------------------------------------------------

/**
 * Persist an idempotency record.  Called after a successful POST response is
 * assembled so the next identical call returns the cached value.
 *
 * `ttlSeconds` defaults to 86 400 (24 h) — callers may pass `IDEMPOTENCY_TTL_SECONDS`
 * from the env to override.
 */
export async function recordIdempotency(
  pool: PoolClient,
  orgId: string,
  route: string,
  key: string,
  requestBodyHash: string,
  responseStatus: number,
  responseBody: unknown,
  ttlSeconds = 86_400,
): Promise<void> {
  const now = Date.now();
  await pool.insert(idempotencyKeys).values({
    orgId,
    route,
    key,
    responseStatus,
    responseBody: JSON.stringify({
      bodyHash: requestBodyHash,
      status: responseStatus,
      body: responseBody,
    }),
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
  });
}
