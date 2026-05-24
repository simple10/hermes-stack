/**
 * /v1/connectors — CRUD + rotate-key for connector records.
 *
 * Mirrors /v1/agents with these differences:
 *   - Token prefix: 'mccnn_'
 *   - POST/PATCH/DELETE all require owner|admin (no member — connectors are a bigger commitment)
 *   - Active gate on DELETE: checks db.externalRefs(ctx).countBySource(id)
 *     (409 connector.has_active_refs if > 0)
 *   - Events: connector.created, connector.updated, connector.deleted, connector.key_rotated
 *
 * Saga pattern for POST:
 *   1. INSERT connector row; on UNIQUE violation → 409 connector.duplicate_name.
 *   2. mintApiKey with prefix 'mccnn_'.
 *   3. If step 2 throws → compensate: soft-delete connector with deleted_by_type='system'.
 *      Return 500 connector.key_mint_failed (no event emitted).
 *   4. Emit connector.created; return { connector, key }.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, requireMember } from '../auth/middleware.ts';
import { HttpError, errorResponse } from '../errors.ts';
import { serializeTimestamps } from '../db/helpers.ts';
import { db } from '../db/repos/index.ts';
import { encodeCursor, decodeCursor, clampLimit } from '../pagination.ts';
import type { AuthContext } from '../auth/types.ts';

const DEFAULT_GRACE = 300; // seconds

type Variables = { auth: AuthContext };

export const connectorsRouter = new Hono<{ Variables: Variables }>();
connectorsRouter.use('*', authMiddleware);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().min(1).max(100),
  kind: z.string().min(1).max(50),
  description: z.string().max(1000).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
});

// ---------------------------------------------------------------------------
// POST /v1/connectors
// ---------------------------------------------------------------------------

connectorsRouter.post('/', requireMember('owner', 'admin'), async (c) => {
  try {
    const ctx = c.var.auth;

    const raw = await c.req.json().catch(() => {
      throw new HttpError(400, 'connector.bad_request', 'Request body must be valid JSON');
    });
    const input = createSchema.safeParse(raw);
    if (!input.success) {
      throw new HttpError(
        400,
        'connector.validation_error',
        input.error.issues[0]?.message ?? 'Validation failed',
        input.error.issues,
      );
    }
    const { name, kind, description } = input.data;

    // Step 1: INSERT connector row.
    // DuplicateError (connector.duplicate_name) → errorResponse → 409.
    const connector = await db.connectors(ctx).insert({
      name,
      kind,
      description: description ?? null,
      createdByUserId: ctx.viaUserId ?? null,
    });

    // Step 2: Mint the connector API key.
    let rawKey: string;
    try {
      const minted = await db.apiKeys(ctx).mintForConnector(connector.id, {
        name: `connector key: ${name}`,
      });
      rawKey = minted.rawKey;
    } catch (mintErr) {
      // Compensating action: soft-delete the connector with actor='system'.
      await db.connectors(ctx).softDelete(connector.id, { type: 'system', id: null });
      console.error('connector.key_mint_failed during compensating delete:', mintErr);
      throw new HttpError(500, 'connector.key_mint_failed', 'Failed to mint connector API key; connector creation rolled back');
    }

    // Step 3: Emit event.
    await db.events(ctx).emit({
      resourceType: 'connector',
      resourceId: connector.id,
      kind: 'connector.created',
    });

    return c.json({ connector: serializeTimestamps(connector), key: rawKey }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// GET /v1/connectors
// ---------------------------------------------------------------------------

connectorsRouter.get('/', requireMember('owner', 'admin', 'member'), async (c) => {
  try {
    const ctx = c.var.auth;
    const env = c.env as any;

    const limitRaw = c.req.query('limit');
    const cursorRaw = c.req.query('cursor');
    const limit = clampLimit(limitRaw, 50, 100);

    const secret = (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET ?? '';

    let cursor: { updatedAt: number; id: string } | undefined;

    if (cursorRaw) {
      const decoded = await decodeCursor(cursorRaw, secret);
      if (!decoded || decoded.orgId !== ctx.orgId) {
        throw new HttpError(400, 'connector.invalid_cursor', 'Invalid or expired pagination cursor');
      }
      cursor = { updatedAt: decoded.updatedAt, id: decoded.id };
    }

    let rows = await db.connectors(ctx).list({ limit: limit + 1, cursor });

    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = rows[rows.length - 1]!;
      nextCursor = await encodeCursor(
        { updatedAt: last.updatedAt, id: last.id, orgId: ctx.orgId },
        secret,
      );
    }

    return c.json({
      connectors: rows.map(serializeTimestamps),
      next_cursor: nextCursor,
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// GET /v1/connectors/:id
// ---------------------------------------------------------------------------

connectorsRouter.get('/:id', requireMember('owner', 'admin', 'member'), async (c) => {
  try {
    const ctx = c.var.auth;
    const id = c.req.param('id');

    const row = await db.connectors(ctx).findById(id);
    if (!row) {
      throw new HttpError(404, 'connector.not_found', `Connector ${id} not found`);
    }

    return c.json({ connector: serializeTimestamps(row) });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// PATCH /v1/connectors/:id
// ---------------------------------------------------------------------------

connectorsRouter.patch('/:id', requireMember('owner', 'admin'), async (c) => {
  try {
    const ctx = c.var.auth;
    const id = c.req.param('id');

    const raw = await c.req.json().catch(() => {
      throw new HttpError(400, 'connector.bad_request', 'Request body must be valid JSON');
    });
    const input = updateSchema.safeParse(raw);
    if (!input.success) {
      throw new HttpError(
        400,
        'connector.validation_error',
        input.error.issues[0]?.message ?? 'Validation failed',
        input.error.issues,
      );
    }

    const existing = await db.connectors(ctx).findById(id);
    if (!existing) {
      throw new HttpError(404, 'connector.not_found', `Connector ${id} not found`);
    }

    const patch: { name?: string; description?: string | null } = {};
    if (input.data.name !== undefined) patch.name = input.data.name;
    if ('description' in input.data) patch.description = input.data.description ?? null;

    const updated = await db.connectors(ctx).update(id, patch);

    await db.events(ctx).emit({
      resourceType: 'connector',
      resourceId: id,
      kind: 'connector.updated',
    });

    return c.json({ connector: serializeTimestamps(updated!) });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// DELETE /v1/connectors/:id
// ---------------------------------------------------------------------------

connectorsRouter.delete('/:id', requireMember('owner', 'admin'), async (c) => {
  try {
    const ctx = c.var.auth;
    const id = c.req.param('id');

    const existing = await db.connectors(ctx).findById(id);
    if (!existing) {
      throw new HttpError(404, 'connector.not_found', `Connector ${id} not found`);
    }

    // Active external-refs gate.
    const activeRefCount = await db.externalRefs(ctx).countBySource(id);
    if (activeRefCount > 0) {
      // Fetch the actual ref ids for the error details.
      const refs = await db.externalRefs(ctx).list({ sourceId: id });
      throw new HttpError(
        409,
        'connector.has_active_refs',
        'Connector has active external references; remove them before deleting',
        { ref_ids: refs.map((r) => r.id) },
      );
    }

    await db.connectors(ctx).softDelete(id);

    await db.events(ctx).emit({
      resourceType: 'connector',
      resourceId: id,
      kind: 'connector.deleted',
    });

    return c.json({}, 200);
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// POST /v1/connectors/:id/rotate-key
// ---------------------------------------------------------------------------

connectorsRouter.post('/:id/rotate-key', requireMember('owner', 'admin'), async (c) => {
  try {
    const ctx = c.var.auth;
    const env = c.env as any;
    const id = c.req.param('id');

    const existing = await db.connectors(ctx).findById(id);
    if (!existing) {
      throw new HttpError(404, 'connector.not_found', `Connector ${id} not found`);
    }

    // Find the current active key for this connector.
    const oldKeyRow = await db.apiKeys(ctx).findActiveForConnector(id);

    // Step 1: Mint new key.
    const { rawKey: newRawKey } = await db.apiKeys(ctx).mintForConnector(id, {
      name: `connector key: ${existing.name}`,
    });

    // Step 2: Expire old key with grace window.
    const graceSeconds =
      parseInt((env as { KEY_ROTATION_GRACE_SECONDS?: string }).KEY_ROTATION_GRACE_SECONDS ?? '', 10) ||
      DEFAULT_GRACE;
    const expiresOldAt = Date.now() + graceSeconds * 1000;

    if (oldKeyRow) {
      await db.apiKeys(ctx).revoke(oldKeyRow.id, expiresOldAt);
    }

    // Step 3: Emit event (no raw key in payload).
    await db.events(ctx).emit({
      resourceType: 'connector',
      resourceId: id,
      kind: 'connector.key_rotated',
      payload: { rotated_at: new Date().toISOString() },
    });

    return c.json({
      key: newRawKey,
      expires_old_at: oldKeyRow ? new Date(expiresOldAt).toISOString() : null,
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});
