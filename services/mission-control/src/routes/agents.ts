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
 *   Uses db.tasks(ctx).countActiveByAgent(id).  If any → 409 agent.has_active_tasks.
 *
 * rotate-key:
 *   1. Find old key via db.apiKeys(ctx).findActiveForAgent(id).
 *   2. Mint new key via db.apiKeys(ctx).mintForAgent(id, { name }).
 *   3. Set expiresAt on old key row = now + KEY_ROTATION_GRACE_SECONDS*1000.
 *   4. Emit agent.key_rotated.
 *   5. Return { key: newRawKey, expires_old_at }.
 */
import { Hono } from 'hono';
import { authMiddleware, requireMember } from '../auth/middleware.ts';
import { HttpError, errorResponse } from '../errors.ts';
import { serializeTimestamps } from '../db/helpers.ts';
import { db } from '../db/repos/index.ts';
import { encodeCursor, decodeCursor, clampLimit } from '../pagination.ts';
import type { AuthContext } from '../auth/types.ts';
import { AgentCreateBody as createSchema, AgentPatchBody as updateSchema } from '../schemas/agents.ts';

const DEFAULT_GRACE = 300; // seconds

type Variables = { auth: AuthContext };

export const agentsRouter = new Hono<{ Variables: Variables }>();
agentsRouter.use('*', authMiddleware);

// ---------------------------------------------------------------------------
// POST /v1/agents
// ---------------------------------------------------------------------------

agentsRouter.post('/', requireMember('owner', 'admin', 'member'), async (c) => {
  try {
    const ctx = c.var.auth;

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

    // Step 1: INSERT agent row.
    // DuplicateError (agent.duplicate_name) is caught by errorResponse → 409.
    const agent = await db.agents(ctx).insert({
      name,
      kind,
      description: description ?? null,
      createdByUserId: ctx.viaUserId ?? null,
    });

    // Step 2: Mint the agent API key.
    let rawKey: string;
    try {
      const minted = await db.apiKeys(ctx).mintForAgent(agent.id, {
        name: `agent key: ${name}`,
      });
      rawKey = minted.rawKey;
    } catch (mintErr) {
      // Compensating action: soft-delete the agent with actor='system' so that
      // deleted_by_type='system' matches existing behavior (agent never went live).
      await db.agents(ctx).softDelete(agent.id, { type: 'system', id: null });
      console.error('agent.key_mint_failed during compensating delete:', mintErr);
      throw new HttpError(500, 'agent.key_mint_failed', 'Failed to mint agent API key; agent creation rolled back');
    }

    // Step 3: Emit event.
    await db.events(ctx).emit({
      resourceType: 'agent',
      resourceId: agent.id,
      kind: 'agent.created',
    });

    return c.json({ agent: serializeTimestamps(agent), key: rawKey }, 201);
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

    let cursor: { updatedAt: number; id: string } | undefined;

    if (cursorRaw) {
      const decoded = await decodeCursor(cursorRaw, secret);
      if (!decoded || decoded.orgId !== ctx.orgId) {
        throw new HttpError(400, 'agent.invalid_cursor', 'Invalid or expired pagination cursor');
      }
      cursor = { updatedAt: decoded.updatedAt, id: decoded.id };
    }

    let rows = await db.agents(ctx).list({ limit: limit + 1, cursor });

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

    const row = await db.agents(ctx).findById(id);
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

    const existing = await db.agents(ctx).findById(id);
    if (!existing) {
      throw new HttpError(404, 'agent.not_found', `Agent ${id} not found`);
    }

    const patch: { name?: string; description?: string | null } = {};
    if (input.data.name !== undefined) patch.name = input.data.name;
    if ('description' in input.data) patch.description = input.data.description ?? null;

    const updated = await db.agents(ctx).update(id, patch);

    await db.events(ctx).emit({
      resourceType: 'agent',
      resourceId: id,
      kind: 'agent.updated',
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

    const existing = await db.agents(ctx).findById(id);
    if (!existing) {
      throw new HttpError(404, 'agent.not_found', `Agent ${id} not found`);
    }

    // Active-task gate.
    const activeTaskIds = await db.tasks(ctx).listActiveIdsByAgent(id);
    if (activeTaskIds.length > 0) {
      throw new HttpError(
        409,
        'agent.has_active_tasks',
        'Agent has active tasks; reassign or complete them before deleting',
        { task_ids: activeTaskIds },
      );
    }

    await db.agents(ctx).softDelete(id);

    await db.events(ctx).emit({
      resourceType: 'agent',
      resourceId: id,
      kind: 'agent.deleted',
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

    const existing = await db.agents(ctx).findById(id);
    if (!existing) {
      throw new HttpError(404, 'agent.not_found', `Agent ${id} not found`);
    }

    // Find the current active key for this agent.
    const oldKeyRow = await db.apiKeys(ctx).findActiveForAgent(id);

    // Step 1: Mint new key.
    const { rawKey: newRawKey } = await db.apiKeys(ctx).mintForAgent(id, {
      name: `agent key: ${existing.name}`,
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
      resourceType: 'agent',
      resourceId: id,
      kind: 'agent.key_rotated',
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
