/**
 * POST /v1/bootstrap — one-time first-user setup endpoint.
 *
 * Gated by MC_ADMIN_TOKEN.  Creates:
 *   1. A user (via better-auth signUpEmail)
 *   2. An organization + owner member row (via Drizzle — bypasses a double-insert
 *      bug in better-auth's Drizzle adapter for createOrganization)
 *   3. A PAT (via direct Drizzle insert — avoids the NOT NULL constraint on our
 *      custom org_id / principal_type columns that better-auth's createApiKey
 *      does not include in its INSERT).
 *
 * The PAT is stored as a SHA-256 hash (base64url, no padding) so that
 * better-auth's verifyApiKey endpoint can authenticate it identically to keys
 * it creates itself.
 *
 * Once any user exists in the master DB, this endpoint returns 409.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { masterClient } from '../db/client.ts';
import { user, organization, member, apiKey as apiKeyTable } from '../db/master.ts';
import { createAuth } from '../auth/config.ts';
import { errorResponse, HttpError } from '../errors.ts';
import { makeId } from '../ids.ts';

export const bootstrap = new Hono();

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  orgName: z.string().min(1),
  orgSlug: z.string().regex(/^[a-z0-9-]+$/).min(1),
});

// ---------------------------------------------------------------------------
// PAT helpers — replicate better-auth's key generation + storage format so
// that verifyApiKey can authenticate the returned key.
// ---------------------------------------------------------------------------

const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_LENGTH = 64; // better-auth defaultKeyLength

/** Generate a random API key string: `<prefix><64 random chars>` */
function generateRawKey(prefix: string): string {
  let key = prefix;
  const arr = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  for (let i = 0; i < KEY_LENGTH; i++) {
    key += KEY_CHARS[arr[i]! % KEY_CHARS.length];
  }
  return key;
}

/** SHA-256 hash → base64url (no padding), matching better-auth's storage format. */
async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuf);
  // base64url (RFC 4648 §5), no padding
  let b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------

bootstrap.post('/', async (c) => {
  try {
    const env = c.env as any;

    // Gate 1: MC_ADMIN_TOKEN must be configured.
    if (!env.MC_ADMIN_TOKEN) {
      return errorResponse(c, new HttpError(403, 'bootstrap.disabled', 'MC_ADMIN_TOKEN not configured'));
    }

    // Gate 2: caller must present the correct token.
    const adminToken = c.req.header('x-mc-admin-token');
    if (adminToken !== env.MC_ADMIN_TOKEN) {
      return errorResponse(c, new HttpError(403, 'bootstrap.unauthorized', 'Invalid admin token'));
    }

    // Gate 3: no users may exist yet.
    const master = masterClient(env);
    const existing = await master.select({ id: user.id }).from(user).limit(1);
    if (existing.length > 0) {
      return errorResponse(
        c,
        new HttpError(409, 'bootstrap.already_done', 'A user already exists; bootstrap endpoint is closed'),
      );
    }

    // Validate body.
    const raw = await c.req.json().catch(() => {
      throw new HttpError(400, 'bootstrap.bad_request', 'Request body must be valid JSON');
    });
    const input = bodySchema.safeParse(raw);
    if (!input.success) {
      throw new HttpError(
        400,
        'bootstrap.validation_error',
        input.error.issues[0]?.message ?? 'Validation failed',
        input.error.issues,
      );
    }
    const { email, password, name, orgName, orgSlug } = input.data;

    const auth = createAuth(env);

    // Step 1: Sign up the user via better-auth (creates user + account rows).
    const signUp = await auth.api.signUpEmail({
      body: { email, password, name },
    });
    if (!signUp || !signUp.user) {
      throw new HttpError(500, 'bootstrap.signup_failed', 'sign-up failed');
    }
    const userId = signUp.user.id;

    // Step 2: Insert organization + member directly via Drizzle.
    //
    // We bypass auth.api.createOrganization because better-auth's Drizzle adapter
    // has a double-insert bug: the low-level adapter.createOrganization() already
    // inserts the member row, and then the endpoint code calls adapter.createMember()
    // a second time, violating the UNIQUE(organization_id, user_id) constraint.
    const now = new Date();
    const orgId = makeId('org');
    const memberId = makeId('mbr');

    await master.insert(organization).values({
      id: orgId,
      name: orgName,
      slug: orgSlug,
      createdAt: now,
    });

    await master.insert(member).values({
      id: memberId,
      organizationId: orgId,
      userId,
      role: 'owner',
      createdAt: now,
    });

    // Step 3: Mint a PAT directly via Drizzle.
    //
    // We bypass auth.api.createApiKey because our custom columns (org_id,
    // principal_type) have NOT NULL constraints that better-auth's INSERT does
    // not include.  We replicate better-auth's key generation + storage format
    // exactly so that auth.api.verifyApiKey can authenticate the key:
    //   - Raw key:    mcpat_<64 random alpha chars>
    //   - Stored key: SHA-256(raw) → base64url, no padding
    const PAT_PREFIX = 'mcpat_';
    const rawKey = generateRawKey(PAT_PREFIX);
    const hashedKey = await hashKey(rawKey);
    const keyId = makeId('apk');

    await master.insert(apiKeyTable).values({
      id: keyId,
      name: 'bootstrap PAT',
      prefix: PAT_PREFIX,
      // Store only the first 7 chars as "start" (better-auth default: 7).
      start: rawKey.substring(0, 7),
      key: hashedKey,
      userId,
      orgId,
      principalType: 'pat',
      enabled: true,
      rateLimitEnabled: true,
      requestCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    return c.json(
      {
        user: { id: userId, email },
        organization: { id: orgId, name: orgName, slug: orgSlug },
        pat: rawKey,
      },
      201,
    );
  } catch (e) {
    return errorResponse(c, e);
  }
});
