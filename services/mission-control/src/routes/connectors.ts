/**
 * /v1/connectors — CRUD + rotate-key for connector records.
 *
 * Mirrors /v1/agents with these differences:
 *   - Token prefix: 'mccnn_'
 *   - POST/PATCH/DELETE all require owner|admin (no member — connectors are a bigger commitment)
 *   - Active gate on DELETE: checks external_refs WHERE source_id=:id AND deleted_at IS NULL
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
import { and, eq, isNotNull } from 'drizzle-orm';
import { authMiddleware, requireMember } from '../auth/middleware.ts';
import { mintApiKey, disableApiKey } from '../auth/api-keys.ts';
import { masterClient } from '../db/client.ts';
import { apiKey as apiKeyTable } from '../db/master.ts';
import { connectors, externalRefs } from '../db/pool.ts';
import { HttpError, errorResponse } from '../errors.ts';
import { makeId } from '../ids.ts';
import { active, serializeTimestamps } from '../db/helpers.ts';
import { emitEvent } from '../events/emit.ts';
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
    const env = c.env as any;

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

    const connectorId = makeId('connector');
    const now = Date.now();

    // Step 1: INSERT connector row.
    try {
      await ctx.pool.insert(connectors).values({
        id: connectorId,
        orgId: ctx.orgId,
        name,
        kind,
        description: description ?? null,
        createdByUserId: ctx.viaUserId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        throw new HttpError(409, 'connector.duplicate_name', `A connector named '${name}' already exists in this org`);
      }
      throw e;
    }

    // Step 2: Mint the connector API key.
    let rawKey: string;
    try {
      const master = masterClient(env);
      const result = await mintApiKey(master, {
        prefix: 'mccnn_',
        name: `connector key: ${name}`,
        userId: ctx.viaUserId ?? ctx.principal.id,
        orgId: ctx.orgId,
        principalType: 'connector',
        metadata: { connector_id: connectorId },
      });
      rawKey = result.rawKey;
    } catch (mintErr) {
      // Compensating action: soft-delete the connector.
      await ctx.pool
        .update(connectors)
        .set({
          deletedAt: now,
          deletedByType: 'system',
          deletedById: null,
          updatedAt: now,
        })
        .where(and(eq(connectors.id, connectorId), eq(connectors.orgId, ctx.orgId)));

      console.error('connector.key_mint_failed during compensating delete:', mintErr);
      throw new HttpError(500, 'connector.key_mint_failed', 'Failed to mint connector API key; connector creation rolled back');
    }

    // Step 3: Fetch the inserted row for the response.
    const row = await ctx.pool.query.connectors.findFirst({
      where: and(eq(connectors.id, connectorId), eq(connectors.orgId, ctx.orgId)),
    });
    if (!row) {
      throw new HttpError(500, 'internal', 'Connector row disappeared after insert');
    }

    // Step 4: Emit event.
    await emitEvent(ctx.pool, {
      orgId: ctx.orgId,
      resourceType: 'connector',
      resourceId: connectorId,
      kind: 'connector.created',
      actor: ctx.principal,
    });

    return c.json({ connector: serializeTimestamps(row), key: rawKey }, 201);
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

    let afterUpdatedAt: number | undefined;
    let afterId: string | undefined;

    if (cursorRaw) {
      const decoded = await decodeCursor(cursorRaw, secret);
      if (!decoded || decoded.orgId !== ctx.orgId) {
        throw new HttpError(400, 'connector.invalid_cursor', 'Invalid or expired pagination cursor');
      }
      afterUpdatedAt = decoded.updatedAt;
      afterId = decoded.id;
    }

    const { gt, or } = await import('drizzle-orm');
    let rows: typeof connectors.$inferSelect[];

    if (afterUpdatedAt !== undefined && afterId !== undefined) {
      rows = await ctx.pool
        .select()
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, ctx.orgId),
            active(connectors),
            or(
              gt(connectors.updatedAt, afterUpdatedAt),
              and(eq(connectors.updatedAt, afterUpdatedAt), gt(connectors.id, afterId)),
            ),
          ),
        )
        .orderBy(connectors.updatedAt, connectors.id)
        .limit(limit + 1);
    } else {
      rows = await ctx.pool
        .select()
        .from(connectors)
        .where(and(eq(connectors.orgId, ctx.orgId), active(connectors)))
        .orderBy(connectors.updatedAt, connectors.id)
        .limit(limit + 1);
    }

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

    const row = await ctx.pool.query.connectors.findFirst({
      where: and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId), active(connectors)),
    });
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

    const existing = await ctx.pool.query.connectors.findFirst({
      where: and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId), active(connectors)),
    });
    if (!existing) {
      throw new HttpError(404, 'connector.not_found', `Connector ${id} not found`);
    }

    const now = Date.now();
    const patch: Partial<typeof connectors.$inferInsert> = { updatedAt: now };
    if (input.data.name !== undefined) patch.name = input.data.name;
    if ('description' in input.data) patch.description = input.data.description ?? null;

    await ctx.pool
      .update(connectors)
      .set(patch)
      .where(and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId)));

    const updated = await ctx.pool.query.connectors.findFirst({
      where: and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId)),
    });

    await emitEvent(ctx.pool, {
      orgId: ctx.orgId,
      resourceType: 'connector',
      resourceId: id,
      kind: 'connector.updated',
      actor: ctx.principal,
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

    const existing = await ctx.pool.query.connectors.findFirst({
      where: and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId), active(connectors)),
    });
    if (!existing) {
      throw new HttpError(404, 'connector.not_found', `Connector ${id} not found`);
    }

    // Active external-refs gate.
    const activeRefs = await ctx.pool
      .select({ id: externalRefs.id })
      .from(externalRefs)
      .where(
        and(
          eq(externalRefs.orgId, ctx.orgId),
          eq(externalRefs.sourceId, id),
          isNotNull(externalRefs.id),
          active(externalRefs),
        ),
      );

    if (activeRefs.length > 0) {
      throw new HttpError(
        409,
        'connector.has_active_refs',
        'Connector has active external references; remove them before deleting',
        { ref_ids: activeRefs.map((r) => r.id) },
      );
    }

    const now = Date.now();
    await ctx.pool
      .update(connectors)
      .set({
        deletedAt: now,
        deletedByType: ctx.principal.type,
        deletedById: ctx.principal.id,
        updatedAt: now,
      })
      .where(and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId)));

    await emitEvent(ctx.pool, {
      orgId: ctx.orgId,
      resourceType: 'connector',
      resourceId: id,
      kind: 'connector.deleted',
      actor: ctx.principal,
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

    const existing = await ctx.pool.query.connectors.findFirst({
      where: and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId), active(connectors)),
    });
    if (!existing) {
      throw new HttpError(404, 'connector.not_found', `Connector ${id} not found`);
    }

    const master = masterClient(env);

    // Find the current active key for this connector via metadata.
    const allConnectorKeys = await master
      .select()
      .from(apiKeyTable)
      .where(and(eq(apiKeyTable.orgId, ctx.orgId), eq(apiKeyTable.principalType, 'connector')));

    const oldKeyRow = allConnectorKeys.find((k) => {
      try {
        const meta =
          typeof k.metadata === 'string'
            ? (JSON.parse(k.metadata) as { connector_id?: string })
            : (k.metadata as { connector_id?: string } | null);
        return meta?.connector_id === id && k.enabled !== false;
      } catch {
        return false;
      }
    });

    // Step 1: Mint new key.
    const { rawKey: newRawKey } = await mintApiKey(master, {
      prefix: 'mccnn_',
      name: `connector key: ${existing.name}`,
      userId: ctx.viaUserId ?? ctx.principal.id,
      orgId: ctx.orgId,
      principalType: 'connector',
      metadata: { connector_id: id },
    });

    // Step 2: Expire old key with grace window.
    const graceSeconds =
      parseInt((env as { KEY_ROTATION_GRACE_SECONDS?: string }).KEY_ROTATION_GRACE_SECONDS ?? '', 10) ||
      DEFAULT_GRACE;
    const expiresOldAt = Date.now() + graceSeconds * 1000;

    if (oldKeyRow) {
      await disableApiKey(master, oldKeyRow.id, expiresOldAt);
    }

    // Step 3: Emit event (no raw key in payload).
    await emitEvent(ctx.pool, {
      orgId: ctx.orgId,
      resourceType: 'connector',
      resourceId: id,
      kind: 'connector.key_rotated',
      actor: ctx.principal,
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
