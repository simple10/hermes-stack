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
import { masterClient } from '../db/client.ts';
import { organization, member } from '../db/master.ts';
import { createAuth } from '../auth/config.ts';
import { errorResponse, HttpError } from '../errors.ts';
import { makeId } from '../ids.ts';
import { mintApiKey } from '../auth/api-keys.ts';
import { lookupAnyUserExists } from '../db/repos/users.ts';
import { BootstrapBody as bodySchema } from '../schemas/bootstrap.ts';

export const bootstrap = new Hono();

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
    const anyUserExists = await lookupAnyUserExists(env);
    if (anyUserExists) {
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
    // See mintApiKey comment below for why we use masterClient directly here.
    // repo-escape: bootstrap bypasses better-auth's createOrganization adapter
    // to avoid a double-insert bug (adapter inserts member, endpoint calls
    // createMember again, violating UNIQUE(organization_id, user_id)).
    const master = masterClient(env); // repo-escape: bootstrap runs before ctx exists
    const now = new Date();
    const orgId = makeId('org');
    const memberId = makeId('mbr');

    await master.insert(organization).values({
      id: orgId,
      name: orgName,
      slug: orgSlug,
      createdAt: now,
      updatedAt: now,
    });

    await master.insert(member).values({
      id: memberId,
      organizationId: orgId,
      userId,
      role: 'owner',
      createdAt: now,
    });

    // Step 3: Mint a PAT directly via mintApiKey helper.
    //
    // repo-escape: bootstrap runs before ctx exists, so apiKeysRepo(ctx) is not
    // available. mintApiKey() is a low-level static function that takes a master
    // client directly.
    const { rawKey } = await mintApiKey(master, {
      prefix: 'mcpat_',
      name: 'bootstrap PAT',
      userId,
      orgId,
      principalType: 'pat',
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
