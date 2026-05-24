/**
 * /v1/tasks — full CRUD + state machine + both idempotency layers.
 *
 * Endpoints:
 *   POST   /v1/tasks       create (owner|admin|member|connector)
 *   GET    /v1/tasks       list with filters (any authenticated role)
 *   GET    /v1/tasks/:id   detail — task + recent 20 comments + recent 20 events
 *   PATCH  /v1/tasks/:id   update (owner|admin|member|connector; agent: own task + limited fields)
 *   DELETE /v1/tasks/:id   soft delete (owner|admin|connector)
 *
 * Layer-1 idempotency: Idempotency-Key header → idempotency_keys table.
 * Layer-2 idempotency: body.idempotency_key → tasks.idempotency_key unique index.
 *
 * State machine: validateTransition() in src/state-machine/tasks.ts.
 * Invalid transition → 409 task.invalid_transition with details.from + details.to.
 *
 * Initial status:
 *   - POST without agent_id → status = 'pending'
 *   - POST with    agent_id → status = 'ready'; emits task.assigned + task.created
 *
 * Transition side-effects (applied in PATCH handler):
 *   → in_progress (first time): set startedAt if not already set
 *   → completed | failed | cancelled: set completedAt
 *
 * Agent role restrictions:
 *   - GET list: forced agent_id = principal.id
 *   - GET :id:  403 if task.agent_id !== principal.id
 *   - PATCH:    only own task; only status + metadata fields
 *   - DELETE:   forbidden
 *
 * Filter helpers:
 *   - updated_since: ISO string OR ms epoch integer
 *   - status: comma-separated list
 *   - agent_id=me: expands to principal.id (only valid for agent principals)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { authMiddleware, requireAnyRole } from '../auth/middleware.ts';
import { tasks, taskComments, events } from '../db/pool.ts';
import { HttpError, errorResponse, DuplicateError } from '../errors.ts';
import { active, serializeTimestamps } from '../db/helpers.ts';
import { db } from '../db/repos/index.ts';
import { encodeCursor, decodeCursor, clampLimit } from '../pagination.ts';
import { validateTransition, TERMINAL } from '../state-machine/tasks.ts';
import {
  checkIdempotency,
  recordIdempotency,
  hashBody,
} from '../idempotency.ts';
import type { AuthContext } from '../auth/types.ts';

type Variables = { auth: AuthContext };

export const tasksRouter = new Hono<{ Variables: Variables }>();
tasksRouter.use('*', authMiddleware);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const STATUS_VALUES = [
  'pending',
  'ready',
  'in_progress',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;

const createBody = z.object({
  project_id: z.string().min(1),
  title: z.string().min(1).max(500),
  body: z.string().max(50_000).optional(),
  agent_id: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotency_key: z.string().max(200).optional(),
});

const patchBody = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(50_000).optional(),
  agent_id: z.string().nullable().optional(), // null to unassign
  status: z.enum(STATUS_VALUES).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse updated_since from ISO string or ms epoch. Returns ms or null. */
function parseUpdatedSince(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  // Try as integer (ms epoch).
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  // Try as ISO date string.
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.getTime();
  return null;
}

// ---------------------------------------------------------------------------
// POST /v1/tasks
// ---------------------------------------------------------------------------

tasksRouter.post(
  '/',
  requireAnyRole('owner', 'admin', 'member', 'connector'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const env = c.env as { BETTER_AUTH_SECRET?: string; IDEMPOTENCY_TTL_SECONDS?: string };

      const raw = await c.req.json().catch(() => {
        throw new HttpError(400, 'task.bad_request', 'Request body must be valid JSON');
      });

      const input = createBody.safeParse(raw);
      if (!input.success) {
        throw new HttpError(
          400,
          'task.validation_error',
          input.error.issues[0]?.message ?? 'Validation failed',
          input.error.issues,
        );
      }
      const { project_id, title, body: taskBody, agent_id, priority, metadata, idempotency_key } = input.data;

      // ---------------------------------------------------------------------------
      // Layer-1 idempotency (Idempotency-Key header)
      // ---------------------------------------------------------------------------
      const idempotencyHeader = c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key');
      if (idempotencyHeader) {
        const bodyHash = await hashBody(raw);
        const check = await checkIdempotency(
          ctx.pool,
          ctx.orgId,
          'POST /v1/tasks',
          idempotencyHeader,
          bodyHash,
        );
        if (check.hit === true) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return c.json(check.cached.body as any, check.cached.status as 201);
        }
        if (check.hit === 'conflict') {
          throw new HttpError(
            409,
            'idempotency.conflict',
            'Idempotency-Key already used with a different request body',
          );
        }
      }

      // ---------------------------------------------------------------------------
      // Validate project_id exists and is active.
      // ---------------------------------------------------------------------------
      const projectRow = await db.projects(ctx).findById(project_id);
      if (!projectRow) {
        throw new HttpError(422, 'task.invalid_project', `Project '${project_id}' not found or inactive`);
      }

      // ---------------------------------------------------------------------------
      // Validate agent_id if provided.
      // ---------------------------------------------------------------------------
      if (agent_id) {
        const agentRow = await db.agents(ctx).findById(agent_id);
        if (!agentRow) {
          throw new HttpError(422, 'task.invalid_agent', `Agent '${agent_id}' not found or inactive`);
        }
      }

      // ---------------------------------------------------------------------------
      // Insert task.
      // ---------------------------------------------------------------------------
      const initialStatus = agent_id ? 'ready' : 'pending';

      let row: typeof tasks.$inferSelect;
      try {
        row = await db.tasks(ctx).insert({
          projectId: project_id,
          agentId: agent_id ?? null,
          title,
          body: taskBody ?? null,
          status: initialStatus,
          priority: priority ?? 0,
          metadata: metadata ? JSON.stringify(metadata) : null,
          idempotencyKey: idempotency_key ?? null,
          createdByUserId: ctx.viaUserId ?? null,
        });
      } catch (e) {
        if (e instanceof DuplicateError && idempotency_key) {
          // Layer-2 semantic dedup: find the conflicting active task.
          const dedupeRows = await ctx.pool
            .select()
            .from(tasks)
            .where(
              and(
                eq(tasks.orgId, ctx.orgId),
                eq(tasks.idempotencyKey, idempotency_key),
                isNull(tasks.deletedAt),
              ),
            )
            .limit(1);
          const existing = dedupeRows[0];
          throw new HttpError(
            409,
            'idempotency.conflict',
            `An active task with idempotency_key '${idempotency_key}' already exists`,
            { existing_task_id: existing?.id ?? null },
          );
        }
        throw e;
      }

      // ---------------------------------------------------------------------------
      // Emit events.
      // ---------------------------------------------------------------------------
      await db.events(ctx).emit({
        resourceType: 'task',
        resourceId: row.id,
        kind: 'task.created',
        payload: { task: serializeTimestamps(row) },
      });

      if (agent_id) {
        await db.events(ctx).emit({
          resourceType: 'task',
          resourceId: row.id,
          kind: 'task.assigned',
          payload: { from: null, to: agent_id },
        });
      }

      const responseBody = { task: serializeTimestamps(row) };

      // ---------------------------------------------------------------------------
      // Record Layer-1 idempotency.
      // ---------------------------------------------------------------------------
      if (idempotencyHeader) {
        const bodyHash = await hashBody(raw);
        const ttlSeconds = parseInt(env.IDEMPOTENCY_TTL_SECONDS ?? '', 10) || 86_400;
        try {
          await recordIdempotency(ctx.pool, ctx.orgId, 'POST /v1/tasks', idempotencyHeader, bodyHash, 201, responseBody, ttlSeconds);
        } catch {
          // Non-fatal: if the record fails, the response still goes through.
        }
      }

      return c.json(responseBody, 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /v1/tasks
// ---------------------------------------------------------------------------

tasksRouter.get(
  '/',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const env = c.env as { BETTER_AUTH_SECRET?: string };

      const limitRaw = c.req.query('limit');
      const cursorRaw = c.req.query('cursor');
      const limit = clampLimit(limitRaw, 50, 100);

      const secret = env.BETTER_AUTH_SECRET ?? '';

      // ---------------------------------------------------------------------------
      // Filters
      // ---------------------------------------------------------------------------
      const projectIdFilter = c.req.query('project_id');
      const statusFilter = c.req.query('status');
      const updatedSinceRaw = c.req.query('updated_since');
      const updatedSinceMs = parseUpdatedSince(updatedSinceRaw);

      // agent_id filter — 'me' shorthand + agent-role forced filter.
      let agentIdFilter: string | undefined;
      const agentIdRaw = c.req.query('agent_id');

      if (ctx.role === 'agent') {
        // Agents always see only their own tasks; ignore any provided agent_id.
        // (The repo's per-principal filter also enforces this, but we pass
        //  it explicitly as a filter for consistency with the list() API.)
        agentIdFilter = ctx.principal.id;
      } else if (agentIdRaw === 'me') {
        // 'me' is only valid for agent principals.
        if (ctx.principal.type !== 'agent') {
          throw new HttpError(
            400,
            'task.invalid_filter',
            "agent_id=me is only valid for agent principals",
          );
        }
        agentIdFilter = ctx.principal.id;
      } else if (agentIdRaw) {
        agentIdFilter = agentIdRaw;
      }

      // status — comma-separated list.
      let statusList: string[] | undefined;
      if (statusFilter) {
        statusList = statusFilter.split(',').map((s) => s.trim()).filter(Boolean);
      }

      // ---------------------------------------------------------------------------
      // Cursor decode.
      // ---------------------------------------------------------------------------
      let cursor: { updatedAt: number; id: string } | undefined;

      if (cursorRaw) {
        const decoded = await decodeCursor(cursorRaw, secret);
        if (!decoded || decoded.orgId !== ctx.orgId) {
          throw new HttpError(400, 'task.invalid_cursor', 'Invalid or expired pagination cursor');
        }
        cursor = { updatedAt: decoded.updatedAt, id: decoded.id };
      }

      // ---------------------------------------------------------------------------
      // Query via repo.
      // ---------------------------------------------------------------------------
      let rows = await db.tasks(ctx).list({
        projectId: projectIdFilter,
        agentId: agentIdFilter,
        statuses: statusList as any,
        updatedSince: updatedSinceMs ?? undefined,
        limit: limit + 1,
        cursor,
      });

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
        tasks: rows.map(serializeTimestamps),
        next_cursor: nextCursor,
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /v1/tasks/:id
// ---------------------------------------------------------------------------

tasksRouter.get(
  '/:id',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const id = c.req.param('id');

      // Use findByIdForOrg so we get the task regardless of principal filter,
      // then enforce agent ownership manually to return 403 (not 404).
      const row = await db.tasks(ctx).findByIdForOrg(id);
      if (!row) {
        throw new HttpError(404, 'task.not_found', `Task ${id} not found`);
      }

      // Agent role: can only see own tasks.
      if (ctx.role === 'agent' && row.agentId !== ctx.principal.id) {
        throw new HttpError(403, 'task.forbidden', 'Agents can only access their own tasks');
      }

      // Fetch recent 20 comments.
      const comments = await ctx.pool
        .select()
        .from(taskComments)
        .where(and(eq(taskComments.taskId, id), eq(taskComments.orgId, ctx.orgId), active(taskComments)))
        .orderBy(desc(taskComments.createdAt))
        .limit(20);

      // Fetch recent 20 events.
      const recentEvents = await ctx.pool
        .select()
        .from(events)
        .where(and(eq(events.orgId, ctx.orgId), eq(events.resourceType, 'task'), eq(events.resourceId, id)))
        .orderBy(desc(events.id))
        .limit(20);

      return c.json({
        task: serializeTimestamps(row),
        comments: comments.map(serializeTimestamps),
        events: recentEvents.map(serializeTimestamps),
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /v1/tasks/:id
// ---------------------------------------------------------------------------

tasksRouter.patch(
  '/:id',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const id = c.req.param('id');

      const raw = await c.req.json().catch(() => {
        throw new HttpError(400, 'task.bad_request', 'Request body must be valid JSON');
      });
      const input = patchBody.safeParse(raw);
      if (!input.success) {
        throw new HttpError(
          400,
          'task.validation_error',
          input.error.issues[0]?.message ?? 'Validation failed',
          input.error.issues,
        );
      }

      // Use findByIdForOrg so agent can get a 403 (not 404) on another agent's task.
      const existing = await db.tasks(ctx).findByIdForOrg(id);
      if (!existing) {
        throw new HttpError(404, 'task.not_found', `Task ${id} not found`);
      }

      // ---------------------------------------------------------------------------
      // Agent role restrictions.
      // ---------------------------------------------------------------------------
      if (ctx.role === 'agent') {
        // Agents can only patch their own tasks.
        if (existing.agentId !== ctx.principal.id) {
          throw new HttpError(403, 'task.forbidden', 'Agents can only update their own tasks');
        }
        // Agents can only update status and metadata.
        const disallowedKeys = Object.keys(raw).filter(
          (k) => k !== 'status' && k !== 'metadata',
        );
        if (disallowedKeys.length > 0) {
          throw new HttpError(
            403,
            'task.forbidden',
            `Agents may only update status and metadata; disallowed fields: ${disallowedKeys.join(', ')}`,
          );
        }
      }

      const now = Date.now();
      const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: now };

      // ---------------------------------------------------------------------------
      // State machine validation.
      // ---------------------------------------------------------------------------
      let statusFrom: string | null = null;
      let statusTo: string | null = null;

      if (input.data.status !== undefined && input.data.status !== existing.status) {
        const from = existing.status;
        const to = input.data.status;

        if (!validateTransition(from, to)) {
          throw new HttpError(
            409,
            'task.invalid_transition',
            `Cannot transition task from '${from}' to '${to}'`,
            { from, to },
          );
        }

        patch.status = to;
        statusFrom = from;
        statusTo = to;

        // Side-effects.
        if (to === 'in_progress' && !existing.startedAt) {
          patch.startedAt = now;
        }
        if (TERMINAL.has(to as any)) {
          patch.completedAt = now;
        }
      }

      // ---------------------------------------------------------------------------
      // Field updates.
      // ---------------------------------------------------------------------------
      const changedFields: Record<string, [unknown, unknown]> = {};

      if (input.data.title !== undefined && input.data.title !== existing.title) {
        changedFields['title'] = [existing.title, input.data.title];
        patch.title = input.data.title;
      }

      if ('body' in input.data) {
        const newBody = input.data.body ?? null;
        if (newBody !== existing.body) {
          changedFields['body'] = [existing.body, newBody];
          patch.body = newBody;
        }
      }

      if (input.data.priority !== undefined && input.data.priority !== existing.priority) {
        changedFields['priority'] = [existing.priority, input.data.priority];
        patch.priority = input.data.priority;
      }

      if ('metadata' in input.data) {
        const newMeta = input.data.metadata ? JSON.stringify(input.data.metadata) : null;
        if (newMeta !== existing.metadata) {
          changedFields['metadata'] = [existing.metadata, newMeta];
          patch.metadata = newMeta;
        }
      }

      // agent_id change (can be null to unassign).
      let agentIdChanged = false;
      let oldAgentId: string | null = existing.agentId ?? null;
      let newAgentId: string | null = null;

      if ('agent_id' in input.data) {
        newAgentId = input.data.agent_id ?? null;
        if (newAgentId !== oldAgentId) {
          // Validate new agent if not unassigning.
          if (newAgentId) {
            const agentRow = await db.agents(ctx).findById(newAgentId);
            if (!agentRow) {
              throw new HttpError(422, 'task.invalid_agent', `Agent '${newAgentId}' not found or inactive`);
            }
          }
          changedFields['agent_id'] = [oldAgentId, newAgentId];
          patch.agentId = newAgentId;
          agentIdChanged = true;

          // Auto-promote: if assigning an agent to a pending task (and no explicit
          // status transition was requested), atomically set status to 'ready'.
          if (newAgentId !== null && existing.status === 'pending' && statusTo === null) {
            patch.status = 'ready';
            statusFrom = 'pending';
            statusTo = 'ready';
          }
        }
      }

      // Apply update via repo (org-scoped).
      const updated = await db.tasks(ctx).update(id, patch);

      // ---------------------------------------------------------------------------
      // Emit events.
      // ---------------------------------------------------------------------------
      if (statusFrom !== null && statusTo !== null) {
        const existingMeta = existing.metadata
          ? (() => { try { return JSON.parse(existing.metadata) as Record<string, unknown>; } catch { return {}; } })()
          : {};
        const reason =
          statusTo === 'blocked'
            ? (existingMeta['block_reason'] as string | undefined)
            : statusTo === 'failed'
              ? (existingMeta['failure_reason'] as string | undefined)
              : undefined;

        await db.events(ctx).emit({
          resourceType: 'task',
          resourceId: id,
          kind: 'task.status_changed',
          payload: { from: statusFrom, to: statusTo, ...(reason ? { reason } : {}) },
        });
      }

      if (agentIdChanged) {
        await db.events(ctx).emit({
          resourceType: 'task',
          resourceId: id,
          kind: 'task.assigned',
          payload: { from: oldAgentId, to: newAgentId },
        });
      }

      // Emit task.updated for any non-status, non-assignment field changes.
      const nonStatusNonAgentChanges = Object.fromEntries(
        Object.entries(changedFields).filter(([k]) => k !== 'agent_id'),
      );
      if (Object.keys(nonStatusNonAgentChanges).length > 0) {
        await db.events(ctx).emit({
          resourceType: 'task',
          resourceId: id,
          kind: 'task.updated',
          payload: { changed: nonStatusNonAgentChanges },
        });
      }

      return c.json({ task: serializeTimestamps(updated!) });
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /v1/tasks/:id
// ---------------------------------------------------------------------------

tasksRouter.delete(
  '/:id',
  requireAnyRole('owner', 'admin', 'connector'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const id = c.req.param('id');

      const existing = await db.tasks(ctx).findById(id);
      if (!existing) {
        throw new HttpError(404, 'task.not_found', `Task ${id} not found`);
      }

      await db.tasks(ctx).softDelete(id);

      await db.events(ctx).emit({
        resourceType: 'task',
        resourceId: id,
        kind: 'task.deleted',
        payload: {},
      });

      return c.json({}, 200);
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);
