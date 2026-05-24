/**
 * /v1/agents — CRUD + rotate-key for agent records.
 *
 * Endpoints:
 *   POST   /v1/agents                 create (member+)
 *   GET    /v1/agents                 list (any human role)
 *   GET    /v1/agents/:id             detail
 *   PATCH  /v1/agents/:id             update name/description (member+)
 *   DELETE /v1/agents/:id             soft-delete (owner|admin); 409 if active tasks
 *   POST   /v1/agents/:id/rotate-key  mint new key + expire old (owner|admin)
 *
 * Saga pattern for POST:
 *   1. INSERT agent row; on UNIQUE violation → 409 agent.duplicate_name.
 *   2. mintApiKey with prefix 'mcagt_'.
 *   3. If step 2 throws → compensate: soft-delete agent with deleted_by_type='system'.
 *      Return 500 agent.key_mint_failed (no event emitted — agent never became real).
 *   4. Emit agent.created; return { agent, key }.
 *
 * Active-task gate for DELETE:
 *   Query pool.tasks WHERE org_id=orgId AND agent_id=:id AND deleted_at IS NULL
 *   AND status IN ('ready','in_progress','blocked').  If any → 409 agent.has_active_tasks.
 *
 * rotate-key:
 *   1. Mint new key.
 *   2. Set expiresAt on old key row = now + KEY_ROTATION_GRACE_SECONDS*1000.
 *   3. Emit agent.key_rotated.
 *   4. Return { key: newRawKey, expires_old_at }.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { authMiddleware, requireMember } from '../auth/middleware.ts';
import { mintApiKey, disableApiKey } from '../auth/api-keys.ts';
import { masterClient } from '../db/client.ts';
import { apiKey as apiKeyTable } from '../db/master.ts';
import { agents, tasks } from '../db/pool.ts';
import { HttpError, errorResponse } from '../errors.ts';
import { makeId } from '../ids.ts';
import { active, serializeTimestamps } from '../db/helpers.ts';
import { emitEvent } from '../events/emit.ts';
import { encodeCursor, decodeCursor, clampLimit } from '../pagination.ts';
import type { AuthContext } from '../auth/types.ts';

const DEFAULT_GRACE = 300; // seconds

type Variables = { auth: AuthContext };

export const agentsRouter = new Hono<{ Variables: Variables }>();
agentsRouter.use('*', authMiddleware);

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
// POST /v1/agents
// ---------------------------------------------------------------------------

agentsRouter.post('/', requireMember('owner', 'admin', 'member'), async (c) => {
  try {
    const ctx = c.var.auth;
    const env = c.env as any;

    const raw = await c.req.json().catch(() => {
      throw new HttpError(400, 'agent.bad_request', 'Request body must be valid JSON');
    });
    const input = createSchema.safeParse(raw);
    if (!input.success) {
      throw new HttpError(
        400,
        'agent.validation_error',
        input.error.issues[0]?.message ?? 'Validation failed',
        input.error.issues,
      );
    }
    const { name, kind, description } = input.data;

    const agentId = makeId('agent');
    const now = Date.now();

    // Step 1: INSERT agent row.
    try {
      await ctx.pool.insert(agents).values({
        id: agentId,
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
        throw new HttpError(409, 'agent.duplicate_name', `An agent named '${name}' already exists in this org`);
      }
      throw e;
    }

    // Step 2: Mint the agent API key.
    let rawKey: string;
    try {
      const master = masterClient(env);
      const result = await mintApiKey(master, {
        prefix: 'mcagt_',
        name: `agent key: ${name}`,
        userId: ctx.viaUserId ?? ctx.principal.id,
        orgId: ctx.orgId,
        principalType: 'agent',
        metadata: { agent_id: agentId },
      });
      rawKey = result.rawKey;
    } catch (mintErr) {
      // Compensating action: soft-delete the agent so the name becomes available again.
      await ctx.pool
        .update(agents)
        .set({
          deletedAt: now,
          deletedByType: 'system',
          deletedById: null,
          updatedAt: now,
        })
        .where(and(eq(agents.id, agentId), eq(agents.orgId, ctx.orgId)));

      console.error('agent.key_mint_failed during compensating delete:', mintErr);
      throw new HttpError(500, 'agent.key_mint_failed', 'Failed to mint agent API key; agent creation rolled back');
    }

    // Step 3: Fetch the inserted row for the response.
    const agentInsertRows = await ctx.pool
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, ctx.orgId)))
      .limit(1);
    const row = agentInsertRows[0];
    if (!row) {
      throw new HttpError(500, 'internal', 'Agent row disappeared after insert');
    }

    // Step 4: Emit event.
    await emitEvent(ctx.pool, {
      orgId: ctx.orgId,
      resourceType: 'agent',
      resourceId: agentId,
      kind: 'agent.created',
      actor: ctx.principal,
    });

    return c.json({ agent: serializeTimestamps(row), key: rawKey }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// GET /v1/agents
// ---------------------------------------------------------------------------

agentsRouter.get('/', requireMember('owner', 'admin', 'member'), async (c) => {
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
        throw new HttpError(400, 'agent.invalid_cursor', 'Invalid or expired pagination cursor');
      }
      afterUpdatedAt = decoded.updatedAt;
      afterId = decoded.id;
    }

    // Keyset pagination: WHERE (updated_at, id) > (cursor.updatedAt, cursor.id)
    const { gt, or } = await import('drizzle-orm');
    let rows: typeof agents.$inferSelect[];

    if (afterUpdatedAt !== undefined && afterId !== undefined) {
      rows = await ctx.pool
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.orgId, ctx.orgId),
            active(agents),
            or(
              gt(agents.updatedAt, afterUpdatedAt),
              and(eq(agents.updatedAt, afterUpdatedAt), gt(agents.id, afterId)),
            ),
          ),
        )
        .orderBy(agents.updatedAt, agents.id)
        .limit(limit + 1);
    } else {
      rows = await ctx.pool
        .select()
        .from(agents)
        .where(and(eq(agents.orgId, ctx.orgId), active(agents)))
        .orderBy(agents.updatedAt, agents.id)
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
      agents: rows.map(serializeTimestamps),
      next_cursor: nextCursor,
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// GET /v1/agents/:id
// ---------------------------------------------------------------------------

agentsRouter.get('/:id', requireMember('owner', 'admin', 'member'), async (c) => {
  try {
    const ctx = c.var.auth;
    const id = c.req.param('id');

    const agentDetailRows = await ctx.pool
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, ctx.orgId), active(agents)))
      .limit(1);
    const row = agentDetailRows[0];
    if (!row) {
      throw new HttpError(404, 'agent.not_found', `Agent ${id} not found`);
    }

    return c.json({ agent: serializeTimestamps(row) });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// PATCH /v1/agents/:id
// ---------------------------------------------------------------------------

agentsRouter.patch('/:id', requireMember('owner', 'admin', 'member'), async (c) => {
  try {
    const ctx = c.var.auth;
    const id = c.req.param('id');

    const raw = await c.req.json().catch(() => {
      throw new HttpError(400, 'agent.bad_request', 'Request body must be valid JSON');
    });
    const input = updateSchema.safeParse(raw);
    if (!input.success) {
      throw new HttpError(
        400,
        'agent.validation_error',
        input.error.issues[0]?.message ?? 'Validation failed',
        input.error.issues,
      );
    }

    const existingRows = await ctx.pool
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, ctx.orgId), active(agents)))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      throw new HttpError(404, 'agent.not_found', `Agent ${id} not found`);
    }

    const now = Date.now();
    const patch: Partial<typeof agents.$inferInsert> = { updatedAt: now };
    if (input.data.name !== undefined) patch.name = input.data.name;
    if ('description' in input.data) patch.description = input.data.description ?? null;

    await ctx.pool
      .update(agents)
      .set(patch)
      .where(and(eq(agents.id, id), eq(agents.orgId, ctx.orgId)));

    const updatedRows = await ctx.pool
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, ctx.orgId)))
      .limit(1);
    const updated = updatedRows[0];

    await emitEvent(ctx.pool, {
      orgId: ctx.orgId,
      resourceType: 'agent',
      resourceId: id,
      kind: 'agent.updated',
      actor: ctx.principal,
    });

    return c.json({ agent: serializeTimestamps(updated!) });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// DELETE /v1/agents/:id
// ---------------------------------------------------------------------------

agentsRouter.delete('/:id', requireMember('owner', 'admin'), async (c) => {
  try {
    const ctx = c.var.auth;
    const id = c.req.param('id');

    const deleteCheckRows = await ctx.pool
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, ctx.orgId), active(agents)))
      .limit(1);
    const existing = deleteCheckRows[0];
    if (!existing) {
      throw new HttpError(404, 'agent.not_found', `Agent ${id} not found`);
    }

    // Active-task gate.
    const ACTIVE_STATUSES = ['ready', 'in_progress', 'blocked'] as const;
    const activeTasks = await ctx.pool
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.orgId, ctx.orgId),
          eq(tasks.agentId, id),
          isNotNull(tasks.agentId),
          active(tasks),
          inArray(tasks.status, ACTIVE_STATUSES as unknown as string[]),
        ),
      );

    if (activeTasks.length > 0) {
      throw new HttpError(
        409,
        'agent.has_active_tasks',
        'Agent has active tasks; reassign or complete them before deleting',
        { task_ids: activeTasks.map((t) => t.id) },
      );
    }

    const now = Date.now();
    await ctx.pool
      .update(agents)
      .set({
        deletedAt: now,
        deletedByType: ctx.principal.type,
        deletedById: ctx.principal.id,
        updatedAt: now,
      })
      .where(and(eq(agents.id, id), eq(agents.orgId, ctx.orgId)));

    await emitEvent(ctx.pool, {
      orgId: ctx.orgId,
      resourceType: 'agent',
      resourceId: id,
      kind: 'agent.deleted',
      actor: ctx.principal,
    });

    return c.json({}, 200);
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ---------------------------------------------------------------------------
// POST /v1/agents/:id/rotate-key
// ---------------------------------------------------------------------------

agentsRouter.post('/:id/rotate-key', requireMember('owner', 'admin'), async (c) => {
  try {
    const ctx = c.var.auth;
    const env = c.env as any;
    const id = c.req.param('id');

    const rotateCheckRows = await ctx.pool
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, ctx.orgId), active(agents)))
      .limit(1);
    const existing = rotateCheckRows[0];
    if (!existing) {
      throw new HttpError(404, 'agent.not_found', `Agent ${id} not found`);
    }

    const master = masterClient(env);

    // Find the current active key for this agent via metadata.
    // Metadata is stored as JSON string; we query all agent keys for this org
    // and filter by agent_id in metadata.
    const allAgentKeys = await master
      .select()
      .from(apiKeyTable)
      .where(and(eq(apiKeyTable.orgId, ctx.orgId), eq(apiKeyTable.principalType, 'agent')));

    const oldKeyRow = allAgentKeys.find((k) => {
      try {
        const meta =
          typeof k.metadata === 'string'
            ? (JSON.parse(k.metadata) as { agent_id?: string })
            : (k.metadata as { agent_id?: string } | null);
        return meta?.agent_id === id && k.enabled !== false;
      } catch {
        return false;
      }
    });

    // Step 1: Mint new key.
    const { rawKey: newRawKey } = await mintApiKey(master, {
      prefix: 'mcagt_',
      name: `agent key: ${existing.name}`,
      userId: ctx.viaUserId ?? ctx.principal.id,
      orgId: ctx.orgId,
      principalType: 'agent',
      metadata: { agent_id: id },
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
      resourceType: 'agent',
      resourceId: id,
      kind: 'agent.key_rotated',
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
