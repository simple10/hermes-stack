/**
 * /v1/events — change log read API for connectors / consumers.
 *
 * Endpoints:
 *   GET /v1/events    list events since cursor (owner|admin|member|connector)
 *
 * Role: NOT agent. Events carry resource data across the whole org; per-row
 * agent-visibility filtering would require joining events to underlying
 * resources on every read. Connector role's whole-org read is the right
 * consumer surface; plugins / connectors filter client-side.
 *
 * Query:
 *   since   integer event id, exclusive lower bound (default 0)
 *   kinds   comma-separated resource_type values (default all)
 *   limit   1-200 (default 100)
 *   cursor  opaque; when present overrides `since` for within-window paging
 *
 * Response: { events: [...], next_cursor: <opaque>|null }
 *
 * The events.id is monotonic per pool DB; v1 has one pool so a single
 * integer since-cursor suffices. Consumers save the highest `id` seen and
 * pass it back as `since` on the next poll. `next_cursor` is used only when
 * a single since-window itself spans more than `limit` events.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, requireAnyRole } from '../auth/middleware.ts';
import { HttpError, errorResponse } from '../errors.ts';
import { serializeTimestamps } from '../db/helpers.ts';
import { db } from '../db/repos/index.ts';
import type { AuthContext } from '../auth/types.ts';

type Variables = { auth: AuthContext };

export const eventsRouter = new Hono<{ Variables: Variables }>();
eventsRouter.use('*', authMiddleware);

const VALID_KINDS = ['task', 'project', 'agent', 'connector', 'comment', 'external_ref'] as const;

const querySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  kinds: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// GET /v1/events
// ---------------------------------------------------------------------------

eventsRouter.get(
  '/',
  requireAnyRole('owner', 'admin', 'member', 'connector'),
  async (c) => {
    try {
      const ctx = c.var.auth;

      const url = new URL(c.req.url);
      const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) {
        throw new HttpError(
          400,
          'events.validation_error',
          parsed.error.issues[0]?.message ?? 'Validation failed',
          parsed.error.issues,
        );
      }
      const { since, kinds, limit, cursor } = parsed.data;

      let kindsList: string[] | undefined;
      if (kinds) {
        kindsList = kinds.split(',').map((s) => s.trim()).filter(Boolean);
        for (const k of kindsList) {
          if (!(VALID_KINDS as readonly string[]).includes(k)) {
            throw new HttpError(
              400,
              'events.invalid_kind',
              `invalid kind '${k}'; valid: ${VALID_KINDS.join(',')}`,
            );
          }
        }
      }

      const { rows, nextCursorId } = await db.events(ctx).list({
        since,
        kinds: kindsList,
        limit,
        cursor: cursor ?? null,
      });

      // Decode payload (stored as TEXT JSON) into objects for the response.
      const out = rows.map((r) => {
        const serialized = serializeTimestamps(r) as Record<string, unknown>;
        let payload: unknown = null;
        if (r.payload !== null && r.payload !== undefined) {
          try {
            payload = JSON.parse(r.payload as string);
          } catch {
            payload = r.payload;
          }
        }
        return { ...serialized, payload };
      });

      return c.json({
        events: out,
        next_cursor: nextCursorId !== null ? String(nextCursorId) : null,
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);
