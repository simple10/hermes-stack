/**
 * validate-responses — dev-mode middleware that checks outgoing JSON bodies
 * against the canonical Zod response schemas in src/schemas/.
 *
 * Behavior:
 *   - In dev/test only (DB_MODE === 'single'). Cheap early return otherwise.
 *   - On schema drift: logs a console.warn with the failing path + the first
 *     few Zod issues. Never throws, never alters the response.
 *   - Catches drift between handler responses and the schemas the UI consumes.
 *
 * To add a new endpoint: append an entry to ROUTE_SCHEMAS below.
 */
import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'
import {
  Agent,
  AgentListResponse,
  AgentCreateResponse,
  AgentRotateKeyResponse,
} from '../schemas/agents.ts'
import {
  Connector,
  ConnectorListResponse,
  ConnectorCreateResponse,
  ConnectorRotateKeyResponse,
} from '../schemas/connectors.ts'
import { Project, ProjectListResponse } from '../schemas/projects.ts'
import {
  TaskListResponse,
  TaskDetailResponse,
  TaskCreateResponse,
  TaskPatchResponse,
} from '../schemas/tasks.ts'
import { CommentListResponse, CommentCreateResponse } from '../schemas/comments.ts'
import { EventListResponse } from '../schemas/events.ts'
import { ExternalRefListResponse, ExternalRefCreateResponse } from '../schemas/external-refs.ts'
import { MeResponse } from '../schemas/me.ts'
import { BootstrapResponse } from '../schemas/bootstrap.ts'

// Matches /v1/... and /api/v1/... — Task 1.9 will migrate the mount but the
// schemas don't change, so the middleware survives the rename.
const PREFIX = '(?:/api)?/v1'

const ROUTE_SCHEMAS: Array<{ method: string; pattern: RegExp; schema: z.ZodTypeAny }> = [
  { method: 'POST', pattern: new RegExp(`^${PREFIX}/bootstrap$`), schema: BootstrapResponse },
  { method: 'GET', pattern: new RegExp(`^${PREFIX}/me$`), schema: MeResponse },

  { method: 'GET', pattern: new RegExp(`^${PREFIX}/agents$`), schema: AgentListResponse },
  { method: 'POST', pattern: new RegExp(`^${PREFIX}/agents$`), schema: AgentCreateResponse },
  {
    method: 'GET',
    pattern: new RegExp(`^${PREFIX}/agents/[^/]+$`),
    schema: z.object({ agent: Agent }),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${PREFIX}/agents/[^/]+$`),
    schema: z.object({ agent: Agent }),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${PREFIX}/agents/[^/]+/rotate-key$`),
    schema: AgentRotateKeyResponse,
  },

  { method: 'GET', pattern: new RegExp(`^${PREFIX}/connectors$`), schema: ConnectorListResponse },
  {
    method: 'POST',
    pattern: new RegExp(`^${PREFIX}/connectors$`),
    schema: ConnectorCreateResponse,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${PREFIX}/connectors/[^/]+$`),
    schema: z.object({ connector: Connector }),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${PREFIX}/connectors/[^/]+$`),
    schema: z.object({ connector: Connector }),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${PREFIX}/connectors/[^/]+/rotate-key$`),
    schema: ConnectorRotateKeyResponse,
  },

  { method: 'GET', pattern: new RegExp(`^${PREFIX}/projects$`), schema: ProjectListResponse },
  {
    method: 'POST',
    pattern: new RegExp(`^${PREFIX}/projects$`),
    schema: z.object({ project: Project }),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${PREFIX}/projects/[^/]+$`),
    schema: z.object({ project: Project }),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${PREFIX}/projects/[^/]+$`),
    schema: z.object({ project: Project }),
  },

  { method: 'GET', pattern: new RegExp(`^${PREFIX}/tasks$`), schema: TaskListResponse },
  { method: 'POST', pattern: new RegExp(`^${PREFIX}/tasks$`), schema: TaskCreateResponse },
  { method: 'GET', pattern: new RegExp(`^${PREFIX}/tasks/[^/]+$`), schema: TaskDetailResponse },
  { method: 'PATCH', pattern: new RegExp(`^${PREFIX}/tasks/[^/]+$`), schema: TaskPatchResponse },
  {
    method: 'GET',
    pattern: new RegExp(`^${PREFIX}/tasks/[^/]+/comments$`),
    schema: CommentListResponse,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${PREFIX}/tasks/[^/]+/comments$`),
    schema: CommentCreateResponse,
  },

  { method: 'GET', pattern: new RegExp(`^${PREFIX}/events$`), schema: EventListResponse },

  {
    method: 'GET',
    pattern: new RegExp(`^${PREFIX}/external_refs$`),
    schema: ExternalRefListResponse,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${PREFIX}/external_refs$`),
    schema: ExternalRefCreateResponse,
  },
]

export const validateResponses: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // Self-gate: only run in non-production. Cheap early return otherwise.
  const isDev = c.env.DB_MODE === 'single'
  if (!isDev) {
    await next()
    return
  }

  await next()

  // Only validate successful JSON responses.
  if (c.res.status < 200 || c.res.status >= 300) return
  const ct = c.res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) return

  const url = new URL(c.req.url)
  const entry = ROUTE_SCHEMAS.find((e) => e.method === c.req.method && e.pattern.test(url.pathname))
  if (!entry) return

  // Clone so reading the body doesn't consume it for the actual response.
  const clone = c.res.clone()
  let body: unknown
  try {
    body = await clone.json()
  } catch {
    return
  }

  const result = entry.schema.safeParse(body)
  if (!result.success) {
    console.warn('[validate-responses] schema drift', {
      method: c.req.method,
      path: url.pathname,
      issues: result.error.issues.slice(0, 5), // cap noise
    })
  }
}
