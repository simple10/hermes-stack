/**
 * Opaque cursor pagination — HMAC-signed cursors.
 *
 * Cursor format:  `<bodyB64>.<sigB64>`
 *   body  = JSON.stringify({ updatedAt, id, orgId })
 *   sig   = HMAC-SHA-256 over `body` using BETTER_AUTH_SECRET
 *
 * The HMAC binds cursors to the signing secret and encodes orgId, so:
 *   - A tampered cursor fails the signature check.
 *   - A cursor from one org cannot be replayed against another org — the
 *     handler additionally asserts that cursor.orgId === ctx.orgId.
 *
 * Uses the Web Crypto API (crypto.subtle) — available on Workers and Node 20+.
 */

const enc = new TextEncoder();

/** Encode and sign a pagination cursor. */
export async function encodeCursor(
  payload: { updatedAt: number; id: string; orgId: string },
  secret: string,
): Promise<string> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(body) + '.' + sigB64;
}

/**
 * Verify and decode a pagination cursor.
 *
 * Returns `null` if the cursor is malformed, the signature is invalid, or
 * the base64 decoding fails.  Never throws.
 */
export async function decodeCursor(
  cursor: string,
  secret: string,
): Promise<{ updatedAt: number; id: string; orgId: string } | null> {
  const dot = cursor.indexOf('.');
  if (dot === -1) return null;
  const bodyB64 = cursor.slice(0, dot);
  const sigB64 = cursor.slice(dot + 1);
  if (!bodyB64 || !sigB64) return null;

  let body: string;
  try {
    body = atob(bodyB64);
  } catch {
    return null;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  let sigBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(body));
  if (!valid) return null;

  try {
    return JSON.parse(body) as { updatedAt: number; id: string; orgId: string };
  } catch {
    return null;
  }
}

/**
 * Clamp a raw `limit` query param to [1, max], defaulting to `dflt`.
 *
 * Non-numeric or out-of-range values silently fall back to the default.
 * Callers never see an error for a bad limit — just the clamped value.
 */
export function clampLimit(raw: unknown, dflt = 50, max = 100): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.min(Math.floor(n), max);
}
