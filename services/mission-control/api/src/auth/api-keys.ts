/**
 * API key mint / disable helpers.
 *
 * better-auth's auth.api.createApiKey does NOT honour our custom NOT NULL
 * columns (org_id, principal_type).  We bypass it and INSERT directly via
 * Drizzle, replicating better-auth's key generation + storage format so that
 * auth.api.verifyApiKey can authenticate the returned raw key.
 *
 * Storage format:
 *   raw key  : <prefix><64 random alpha chars>
 *   stored key: SHA-256(raw) → base64url (RFC 4648 §5), no padding
 *   start    : first 7 chars of raw (better-auth default)
 *
 * Exports:
 *   generateRawKey(prefix)   — random key string with the given prefix
 *   hashKey(key)             — SHA-256 → base64url
 *   mintApiKey(master, args) — full INSERT; returns { id, rawKey }
 *   disableApiKey(master, keyId, when?) — sets enabled=false (soft-disable)
 */
import { eq } from 'drizzle-orm'
import { apiKey as apiKeyTable } from '../db/master.ts'
import { makeId } from '../ids.ts'
import type { MasterClient } from '../db/client.ts'

// ---------------------------------------------------------------------------
// Low-level primitives
// ---------------------------------------------------------------------------

const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const KEY_LENGTH = 64 // matches better-auth defaultKeyLength

/** Generate a random API key string: `<prefix><64 random alpha chars>` */
export function generateRawKey(prefix: string): string {
  let key = prefix
  const arr = crypto.getRandomValues(new Uint8Array(KEY_LENGTH))
  for (let i = 0; i < KEY_LENGTH; i++) {
    key += KEY_CHARS[arr[i]! % KEY_CHARS.length]
  }
  return key
}

/** SHA-256 hash → base64url (no padding), matching better-auth's storage format. */
export async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key)
  const hashBuf = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(hashBuf)
  let b64 = btoa(String.fromCharCode(...bytes))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// mintApiKey
// ---------------------------------------------------------------------------

export interface MintApiKeyArgs {
  prefix: string
  name: string
  userId: string
  orgId: string
  principalType: 'pat' | 'agent' | 'connector'
  metadata?: Record<string, unknown>
  permissions?: Record<string, string[]>
}

/**
 * Mint a new API key and INSERT it directly into the apiKey table.
 *
 * Returns the key's database `id` and the raw (plaintext) key — the raw key
 * must be shown to the caller exactly once and is never stored.
 */
export async function mintApiKey(
  master: MasterClient,
  args: MintApiKeyArgs,
): Promise<{ id: string; rawKey: string }> {
  const rawKey = generateRawKey(args.prefix)
  const hashedKey = await hashKey(rawKey)
  const keyId = makeId('apiKey')
  const now = new Date()

  await master.insert(apiKeyTable).values({
    id: keyId,
    name: args.name,
    prefix: args.prefix,
    // Store only the first 7 chars as "start" (better-auth default: 7).
    start: rawKey.substring(0, 7),
    key: hashedKey,
    userId: args.userId,
    // better-auth 1.6+ requires both fields on every key row:
    //   configId='default' = no custom apikey configurations declared
    //   referenceId=userId = user-owned key (matches createApiKey's default
    //   when called without an explicit org-owned binding)
    configId: 'default',
    referenceId: args.userId,
    orgId: args.orgId,
    principalType: args.principalType,
    enabled: true,
    rateLimitEnabled: true,
    requestCount: 0,
    metadata: args.metadata !== undefined ? JSON.stringify(args.metadata) : null,
    permissions: args.permissions !== undefined ? JSON.stringify(args.permissions) : null,
    createdAt: now,
    updatedAt: now,
  })

  return { id: keyId, rawKey }
}

// ---------------------------------------------------------------------------
// disableApiKey
// ---------------------------------------------------------------------------

/**
 * Disable an API key.
 *
 * When `expiresAt` is provided the key is expired at that timestamp (ms).
 * better-auth treats `expiresAt < now` as invalid in verifyApiKey, which
 * gives a grace-window pattern: set expiresAt = now + grace, mint a new key,
 * then the old key dies naturally when the window closes.
 *
 * When `expiresAt` is omitted the key is disabled immediately (enabled=false).
 */
export async function disableApiKey(
  master: MasterClient,
  keyId: string,
  expiresAt?: number,
): Promise<void> {
  const now = new Date()
  await master
    .update(apiKeyTable)
    .set(
      expiresAt !== undefined
        ? { expiresAt: new Date(expiresAt), updatedAt: now }
        : { enabled: false, updatedAt: now },
    )
    .where(eq(apiKeyTable.id, keyId))
}
