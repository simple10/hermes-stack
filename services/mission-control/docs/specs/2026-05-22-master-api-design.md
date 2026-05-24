# MissionControl — Master API Design

**Status:** Draft for review
**Date:** 2026-05-22
**Scope:** v1 of the Master API service (`services/mission-control/`).

This spec covers the central task-coordination API only. Notion connector, hermes adapter, claude adapter, and custom UI each get their own design spec.

---

## Goal

A single API that lets a user create projects and tasks, assigns them to **agent instances** (Hermes VMs, Claude sessions, OpenClaw runs, …), tracks status as agents work, and exposes a unified change log that external systems (Notion, Linear, custom dashboards) can sync against bidirectionally.

The user's mental model: *"I'm creating a task in Notion (or our UI) and assigning it to one of my agents. I want to see the status update in Notion as the agent works."* How the agent decomposes and executes the work internally (subagents, swarms, local kanban) is not the master's concern.

**Architectural principle:** integration happens from the agent up, not the API down. The API stays agent-agnostic; each agent type owns its own adapter. This way, adding a new agent type (or a new connector) doesn't churn API code.

---

## Non-goals (explicit)

- Task hierarchy / parent-child dependencies in the master. Subtask graphs live in agents' local kanbans.
- Per-attempt run history (`task_runs`). Agents track retries locally.
- Webhooks out, server-side cursors, SSE — all v1.1+.
- Custom UI. Notion is the v1 user surface; a custom UI is a separate later project.
- Billing, usage metering, rate limits — schema leaves room (`orgs.plan`) but no enforcement v1.

---

## Deployment model

| | Production (SaaS) | Self-hosted (OSS) | Contributor dev |
|---|---|---|---|
| Runtime | Cloudflare Workers | Node + Hono (via `unenv`) | `wrangler dev` directly |
| Database | D1 (sharded — see below) | Single SQLite file via `better-sqlite3` | Local SQLite via wrangler |
| Cron | Cloudflare Cron Triggers | `node-cron` | n/a v1 |
| Push (v1.1) | Streaming Response (SSE) | Same | Same |

One Hono codebase, two build targets. Driver selection lives in `db/client.ts`; everything above it is agnostic.

---

## Storage architecture

### Two-tier D1 (production)

```
┌──────────────────────────────────────────────────────────┐
│  MASTER (D1 #0)                                          │
│  ───────────                                             │
│  orgs            (id, name, slug, tenant_pool_id, plan)  │
│  users           (id, org_id, email, role)               │
│  api_keys        (hash, prefix, org_id, principal_*,     │
│                   role, scopes, name)                    │
│  tenant_pools    (id, binding_name)                      │
└────────────────────────┬─────────────────────────────────┘
                         │  orgs.tenant_pool_id
                         ▼
┌──────────────────────────────────────────────────────────┐
│  POOL_DEFAULT (D1 #1)   ← v1: every org lives here       │
│  ──────────────────                                      │
│  agents          (id, org_id, name, kind, last_seen_at)  │
│  projects        (id, org_id, name, slug, …)             │
│  tasks           (id, org_id, project_id, agent_id, …)   │
│  task_comments   (id, org_id, task_id, author_*, body)   │
│  events          (id, org_id, resource_*, kind, payload) │
│  external_refs   (id, org_id, resource_*, source_*, …)   │
│  idempotency_keys(id, org_id, route, key, response)      │
└──────────────────────────────────────────────────────────┘

Future:
  POOL_PREMIUM_ACME (D1 #2)   ← dedicated to one paying org
  POOL_SHARDED_001  (D1 #3)   ← spillover for new free-tier signups
```

**Why two tiers:** the api-key lookup must happen *before* we know which pool to query, so identity & routing have to live in a fixed-location master. Everything else is pool-scoped task data and can be sharded.

**Why pre-declared bindings (not dynamic D1 HTTP API):** Workers can't create bindings at runtime, but a small registry mapping `tenant_pool_id → env.POOL_X` lets us pick the right binding per request at native-binding latency. Adding a new pool = `wrangler d1 create` + add to `wrangler.toml` + deploy. Ops event, not hot path.

**Why org-level pool (not user-level):** orgs are the data-sharing boundary. Two users in one org must see each other's tasks, so they must be in the same pool. `tenant_pool_id` lives on `orgs`.

### Single-DB mode (self-hosted / local dev)

For OSS users and contributors: both master and pool schemas live in **one SQLite file**. Since no table names collide between the two schemas (no `tasks` in master, no `orgs` in pool), they coexist cleanly.

**Migration application:**

```
DB_MODE=single   → applies migrations/master/* AND migrations/pool/*
                   to the same DB binding (env.DB)
DB_MODE=split    → applies migrations/master/* to env.MASTER_DB
                   applies migrations/pool/* to env.POOL_DEFAULT (and other pools)
```

The `db/client.ts` resolver returns `{ master, pool }` Drizzle clients. In single mode both wrap the same underlying connection; in split mode they wrap different bindings.

---

## Stack

| Concern | Choice |
|---|---|
| HTTP framework | Hono — runs on Workers, Node, Bun, Deno |
| Database | D1 (Workers) / better-sqlite3 (Node) — same SQL |
| ORM | Drizzle — first-class for both drivers |
| Migrations | SQL files via `wrangler d1 migrations` + Drizzle's migrator |
| Validation | Zod (on every request body and query param) |
| Auth | **better-auth** with `organization` + `apiKey` plugins (Drizzle adapter, master DB only) |
| Logging | Hono's logger middleware + structured JSON to stderr (CF gives us this for free) |
| Testing | Vitest + `@cloudflare/vitest-pool-workers` |

---

## Identity & auth

All identity, sessions, OAuth, and bearer-token verification is handled by **[better-auth](https://better-auth.com)** with its `organization` and `apiKey` plugins. Better-auth runs entirely against the master DB — it has no knowledge of pool DBs. Our custom middleware bridges better-auth's auth context to the pool resolver.

### Why better-auth

- Schema we'd need anyway: `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`.
- Free: sessions, OAuth providers, magic links, email verification, 2FA, password reset, org invitations.
- API-keys plugin gives us prefixed bearer tokens with hashing, rotation, expiration, rate limiting, permissions, metadata — replaces our hand-rolled key table.
- First-class Cloudflare Workers + D1 + Drizzle support. Hono integration via mount.
- Adopting on day one avoids painful retrofits — better-auth's schema is the source of truth for the auth tables.

### Token format

All bearer tokens come from better-auth's apiKey plugin. Better-auth's `prefix` config gives us a uniform leak-scanner-friendly prefix; whether we can vary it per-key (type tag inside the prefix) depends on plugin version. We treat the type tag as a **convention** that the mint endpoint applies if supported, and fall back to a single fixed prefix if not:

```
Preferred (per-key prefix):   mc_pat_<bytes> / mc_agent_<bytes> / mc_connector_<bytes>
Fallback (uniform prefix):    mc_<bytes>      (type lives in metadata.type)
```

Either way, the **source of truth is `apiKey.metadata.type`** — middleware never trusts the prefix for authorization decisions. Tokens are shown to the caller once at creation; only better-auth's hashed value + display prefix are stored.

### Principal model

The credential (api key) is **always owned by a user** (better-auth requires `userId`). The *actor* the system reasons about is determined by `metadata.type`:

| `metadata.type` | Acts as | Bound to entity |
|---|---|---|
| `'pat'` | The human user themselves (full role from `member.role`) | — |
| `'agent'` | An agent in the `agents` table | `metadata.agent_id` |
| `'connector'` | A connector (registered via `POST /v1/connectors`, v1.1) | `metadata.connector_id` |

This is the GitHub-Apps / Slack-bots / Notion-integrations pattern: the credential happens to be owned by a user for audit + revocation, but the actor recorded in events / accessible to handlers is the agent or connector. **Agents are not users.** Agent identity lives in the `agents` table (in pool DB); the api key in master is just the credential.

### Role model

Human roles come from better-auth's organization plugin (per `member.role`):

| role | Scope |
|---|---|
| `owner` | Everything in their org. Manage members, billing, api_keys, agents, projects, all tasks. |
| `admin` | Same as owner except no billing, no removing other admins/owners. |
| `member` | Create/edit projects, tasks, comments. Mint agent keys. No org admin. |

Machine roles (set via `metadata.type` on the api key):

| role | Scope |
|---|---|
| `agent` | Read tasks where `agent_id == metadata.agent_id`. Update those tasks (status + metadata only). Post `external_refs` where `source_id == metadata.agent_id`. Post comments on own tasks. Heartbeats (v1.1). |
| `connector` | Full task & project CRUD across the org. Read `events`. Write `external_refs` where `source_id == metadata.connector_id`. |

Enforcement lives in Hono middleware:
- `requireMember('owner'|'admin'|'member')` for human-scoped routes (uses better-auth session OR PAT)
- `requireMachine('agent'|'connector')` for M2M routes
- `requireOwnAgent` for agent routes that touch a specific task (checks `tasks.agent_id === ctx.principal.id`)

### Auth middleware flow

```
Request with Authorization: Bearer mc_... OR session cookie
              │
              ▼
   ┌─────────────────────────────┐
   │ better-auth.api.getSession() │ ← tries session cookie first
   └──────────────┬──────────────┘
                  │ miss?
                  ▼
   ┌─────────────────────────────┐
   │ better-auth.api.verifyApiKey │ ← tries bearer token
   └──────────────┬──────────────┘
                  │ neither?
                  ▼
              401 auth.invalid
                  │ success
                  ▼
   ┌─────────────────────────────┐
   │ Build auth context:         │
   │  orgId = key.metadata.org_id │
   │      OR session.activeOrg    │
   │  principal: derive from      │
   │    metadata.type (pat|agent  │
   │    |connector)               │
   │  role: from member.role OR   │
   │    metadata.type             │
   └──────────────┬──────────────┘
                  │
                  ▼
   ┌─────────────────────────────┐
   │ resolvePoolForOrg(orgId)    │
   │  → master.organization →    │
   │    tenant_pool_id →         │
   │    env.POOL_<X> binding     │
   │  (60s in-isolate cache)     │
   └──────────────┬──────────────┘
                  │
                  ▼
   ctx = { orgId, role, principal, pool }
                  │
                  ▼
            Route handler
```

The handler-facing `ctx` shape is identical regardless of which auth path resolved it, so route code never branches on session-vs-token.

### Multi-DB resolver

Better-auth queries only master. Our custom resolver maps `orgId → pool binding`:

```typescript
const POOL_BINDING_MAP: Record<string, keyof Env> = {
  'default':       'POOL_DEFAULT',
  'premium-acme':  'POOL_PREMIUM_ACME',
  // … added per provisioning event; deployed via wrangler.toml + this map
};

async function resolvePoolForOrg(env: Env, orgId: string): Promise<DrizzleClient> {
  const tenantPoolId = await orgPoolCache.get(orgId, async () => {
    const org = await master(env).query.organization
      .findFirst({ where: eq(organization.id, orgId), columns: { tenantPoolId: true } });
    if (!org) throw new HttpError(404, 'auth.org_not_found');
    return org.tenantPoolId;
  });
  const binding = env[POOL_BINDING_MAP[tenantPoolId]];
  if (!binding) throw new HttpError(500, 'pool.binding_missing');
  return drizzle(binding, { schema: poolSchema });
}
```

In single-DB mode: `POOL_BINDING_MAP['default'] === 'DB'` — same binding master uses. Resolver returns the same physical client. Zero branching in handlers.

### Bootstrap

For SaaS: better-auth's signup flow handles first-user creation; the first user creates their org via the organization plugin's API; better-auth assigns `member.role='owner'` automatically. From there they mint agent keys via `POST /v1/agents`.

For self-host: `scripts/bootstrap.ts` shells the equivalent calls via better-auth's server-side API to create the first user + org + owner session, then prints credentials. Prevents the chicken-and-egg "no user can sign up because there's no UI yet."

For local dev: same bootstrap script + a seeded dev org with example agents, runnable as `pnpm seed:dev`.

---

## Schema (v1)

All tables include the standard columns:
- `id` (string, slug-prefixed: `org_…`, `usr_…`, `t_…`, `prj_…`, etc.)
- `created_at` (integer, ms since epoch)
- `updated_at` (integer, ms since epoch; bumped on every mutation via Drizzle `$onUpdate`)

User-mutable tables additionally include:
- `deleted_at` (integer nullable; NULL = active)
- `deleted_by_type` (`'user'|'agent'|'connector'|'system'`)
- `deleted_by_id` (string)

Tables exempt from soft-delete: `events` (append-only audit log), `idempotency_keys` (TTL-purged), `cursors` (if added v1.1; just overwrite), `api_keys` (`revoked_at` plays the role).

### Master DB

**Better-auth-managed tables** (schema generated by `@better-auth/cli generate`, committed under `migrations/master/`):

- `user` — id, email, emailVerified, name, image, createdAt, updatedAt
- `session` — id, userId, expiresAt, token, ipAddress, userAgent, activeOrganizationId, createdAt, updatedAt
- `account` — id, userId, accountId, providerId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt
- `verification` — id, identifier, value, expiresAt, createdAt, updatedAt
- `organization` — id, name, slug, logo, createdAt, metadata, **+ custom field** `tenantPoolId`
- `member` — id, organizationId, userId, role ('owner'|'admin'|'member'), createdAt
- `invitation` — id, organizationId, email, role, status, expiresAt, inviterId
- `apiKey` — id, name, start, prefix, key (hashed), userId, refillInterval, refillAmount, lastRefillAt, enabled, rateLimitEnabled, rateLimitTimeWindow, rateLimitMax, requestCount, remaining, lastRequest, expiresAt, createdAt, updatedAt, permissions (JSON), metadata (JSON)

Custom field added to `organization` via better-auth's schema extension mechanism:

```typescript
organization: {
  additionalFields: {
    tenantPoolId: { type: 'string', required: true, defaultValue: 'default' },
    plan: { type: 'string', required: true, defaultValue: 'free' },
    deletedAt: { type: 'date', required: false },
  }
}
```

`apiKey.metadata` (JSON) holds our principal-type discrimination:

```json
{
  "type": "pat" | "agent" | "connector",
  "org_id": "org_xxx",
  "agent_id": "agt_xxx",        // when type='agent'
  "connector_id": "cnn_xxx"     // when type='connector'
}
```

**Custom master tables (not managed by better-auth):**

```sql
CREATE TABLE tenant_pools (
  id            TEXT PRIMARY KEY,        -- 'default', 'premium-acme', 'sharded-001'
  binding_name  TEXT NOT NULL,           -- 'POOL_DEFAULT', 'POOL_PREMIUM_ACME', ...
  created_at    INTEGER NOT NULL
);
```

Tenant_pools is a simple registry — the routing table the Worker consults to map `organization.tenantPoolId` to a binding name. Seeded with `('default', 'POOL_DEFAULT')` at install.

Note: organization soft-delete uses the `deletedAt` custom field above. Better-auth's session/account/verification/apiKey/invitation tables don't get soft-delete — they use their existing lifecycle fields (`enabled`, `revokedAt`, `expiresAt`).

### Pool DB

```sql
CREATE TABLE agents (
  id                  TEXT PRIMARY KEY,                  -- 'agt_xxx'
  org_id              TEXT NOT NULL,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL,                     -- 'hermes'|'claude'|'openclaw'|...
  description         TEXT,
  last_seen_at        INTEGER,
  created_by_user_id  TEXT,                              -- master.user.id (audit only; not FK across DBs)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  deleted_by_type     TEXT,
  deleted_by_id       TEXT
);
CREATE UNIQUE INDEX agents_name_per_org_active
  ON agents(org_id, name) WHERE deleted_at IS NULL;
CREATE INDEX agents_org_kind_active
  ON agents(org_id, kind) WHERE deleted_at IS NULL;

CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,              -- 'prj_xxx'
  org_id              TEXT NOT NULL,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL,
  description         TEXT,
  created_by_user_id  TEXT,                          -- master.user.id (audit)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  deleted_by_type     TEXT,
  deleted_by_id       TEXT
);
CREATE UNIQUE INDEX projects_slug_per_org_active
  ON projects(org_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE tasks (
  id                 TEXT PRIMARY KEY,               -- 't_xxx'
  org_id             TEXT NOT NULL,
  project_id         TEXT NOT NULL,
  agent_id           TEXT,                            -- nullable until assigned
  title              TEXT NOT NULL,
  body               TEXT,
  status             TEXT NOT NULL DEFAULT 'pending', -- see state machine below
  priority           INTEGER NOT NULL DEFAULT 0,
  metadata           TEXT,                            -- JSON, free-form
  idempotency_key    TEXT,                            -- caller-supplied dedup key
  created_by_user_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  started_at         INTEGER,
  completed_at       INTEGER,
  deleted_at         INTEGER,
  deleted_by_type    TEXT,
  deleted_by_id      TEXT
);
CREATE INDEX tasks_org_project_active
  ON tasks(org_id, project_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_org_agent_status_active
  ON tasks(org_id, agent_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_org_updated_at
  ON tasks(org_id, updated_at) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX tasks_idempotency_active
  ON tasks(org_id, idempotency_key) WHERE deleted_at IS NULL AND idempotency_key IS NOT NULL;

CREATE TABLE task_comments (
  id              TEXT PRIMARY KEY,                  -- 'cmt_xxx'
  org_id          TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  author_type     TEXT NOT NULL,                     -- 'user'|'agent'|'connector'|'system'
  author_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  deleted_by_type TEXT,
  deleted_by_id   TEXT
);
CREATE INDEX comments_task_active
  ON task_comments(org_id, task_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic per pool DB
  org_id          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,                     -- 'task'|'project'|'agent'|'comment'
  resource_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,                     -- 'created'|'updated'|'status_changed'|…
  actor_type      TEXT,                              -- 'user'|'agent'|'connector'|'system'
  actor_id        TEXT,
  payload         TEXT,                              -- JSON, kind-specific
  created_at      INTEGER NOT NULL
);
CREATE INDEX events_org_id ON events(org_id, id);
CREATE INDEX events_resource ON events(org_id, resource_type, resource_id);

CREATE TABLE external_refs (
  id              TEXT PRIMARY KEY,                  -- 'xrf_xxx'
  org_id          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,                     -- 'task'|'project'|'agent'|'comment'
  resource_id     TEXT NOT NULL,
  source_kind     TEXT NOT NULL,                     -- 'notion'|'linear'|'hermes'|...
  source_id       TEXT NOT NULL,                     -- 'notion-ws-abc'|'hermes-vm1'|...
  external_id     TEXT NOT NULL,                     -- the foreign system's id
  external_url    TEXT,
  metadata        TEXT,                              -- JSON, source-specific
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  deleted_by_type TEXT,
  deleted_by_id   TEXT
);
CREATE UNIQUE INDEX external_refs_unique_active
  ON external_refs(resource_type, resource_id, source_kind, source_id)
  WHERE deleted_at IS NULL;
CREATE INDEX external_refs_lookup_active
  ON external_refs(org_id, source_kind, external_id) WHERE deleted_at IS NULL;
CREATE INDEX external_refs_reverse_active
  ON external_refs(org_id, resource_type, resource_id) WHERE deleted_at IS NULL;
CREATE INDEX external_refs_source_active
  ON external_refs(org_id, source_kind, source_id) WHERE deleted_at IS NULL;

CREATE TABLE idempotency_keys (
  org_id          TEXT NOT NULL,
  route           TEXT NOT NULL,                     -- 'POST /v1/tasks'
  key             TEXT NOT NULL,                     -- value of Idempotency-Key header
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,                  -- created_at + 24h
  PRIMARY KEY (org_id, route, key)
);
CREATE INDEX idempotency_keys_expires ON idempotency_keys(expires_at);
```

### Polymorphic cascade

`external_refs.resource_id` and `events.resource_id` are polymorphic and not FK-enforced. Two layers of cleanup:

1. **App-level cascade** — every resource delete (soft or hard) goes through a typed helper:
   ```ts
   await deleteResource(db, ctx, { type: 'task', id });
   // → tx: soft-delete task, soft-delete its comments, soft-delete its external_refs,
   //   emit task.deleted event
   ```
2. **SQLite triggers** — defense-in-depth against raw SQL. Per parent table:
   ```sql
   CREATE TRIGGER tasks_soft_delete_cascade
     AFTER UPDATE OF deleted_at ON tasks WHEN NEW.deleted_at IS NOT NULL
   BEGIN
     UPDATE external_refs SET deleted_at = NEW.deleted_at, deleted_by_type = 'system'
       WHERE resource_type = 'task' AND resource_id = NEW.id AND deleted_at IS NULL;
     UPDATE task_comments SET deleted_at = NEW.deleted_at, deleted_by_type = 'system'
       WHERE task_id = NEW.id AND deleted_at IS NULL;
   END;
   ```

### Default-deny reads

A single helper makes `WHERE deleted_at IS NULL` impossible to forget:

```ts
import { isNull, and, eq } from 'drizzle-orm';
export const active = <T extends { deletedAt: Column }>(t: T) => isNull(t.deletedAt);

db.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), active(tasks)));
```

Convention: every read of a soft-deletable table goes through `active()`. Linter rule (added in v1.1) enforces.

### Auto-injected `org_id`

The Drizzle `pool` client is wrapped by a small helper that auto-injects `WHERE org_id = ctx.orgId` on every query, and rejects inserts missing `org_id`. Mistakes get caught at compile time + runtime; tenant isolation isn't dependent on every developer remembering.

---

## API surface (v1)

All routes prefixed `/v1`. JSON in / JSON out. Bearer auth required on every route except `GET /health`.

### Better-auth-managed (mounted at `/v1/auth/*`)

Better-auth ships its own handler covering signup, signin, signout, OAuth, magic links, email verification, password reset, session refresh, organization CRUD, member invitations, and api-key management. We mount it under `/v1/auth/*` and let it handle the request lifecycle there. See the better-auth docs for the full surface.

Key flows we lean on:
- `POST /v1/auth/sign-up/email` — first user signup (creates user + initial org)
- `POST /v1/auth/sign-in/{email,oauth/...,magic-link}` — sessions
- `POST /v1/auth/organization/create` — additional orgs
- `POST /v1/auth/organization/invite-member` — send invitations
- `POST /v1/auth/api-key/create` — mint a PAT for the current user

### Mission-control-managed (mounted at `/v1/*`)

```
GET    /v1/me                       — current resolved principal + org info
                                       returns { org, principal_type, principal_id, role, pool_id }

POST   /v1/agents                   — register an agent (member|admin|owner)
                                       body: { name, kind, description? }
                                       response: { agent: {...}, key: 'mc_agent_...' }
                                       (mints the agent's api key via better-auth;
                                        full key shown once, never stored)
GET    /v1/agents                   — list
GET    /v1/agents/:id
PATCH  /v1/agents/:id
DELETE /v1/agents/:id               — soft delete (owner|admin)
POST   /v1/agents/:id/rotate-key    — revoke old key, mint new (owner|admin)
```

Note: agent-key minting is wrapped by mission-control (not exposed directly via better-auth) because we need to atomically (a) create the agent row in pool DB, (b) mint the better-auth apiKey with the correct metadata pointing to that agent, and (c) record the linkage. One endpoint = one transaction = no orphaned half-states.

### Projects

```
POST   /v1/projects                 — create (member|owner)
GET    /v1/projects                 — list
GET    /v1/projects/:id
PATCH  /v1/projects/:id
DELETE /v1/projects/:id             — soft delete
```

### Tasks

```
POST   /v1/tasks                    — create
                                       body: { project_id, title, body?, agent_id?,
                                               priority?, metadata?, idempotency_key? }
                                       header: Idempotency-Key (optional)
                                       (member|owner|connector)

GET    /v1/tasks                    — list with filters
                                       query: project_id, agent_id, status, updated_since,
                                              cursor, limit (max 100)
                                       agent role: forced agent_id=me

GET    /v1/tasks/:id                — detail
                                       includes recent comments + recent events (latest 20 each)

PATCH  /v1/tasks/:id                — update
                                       body: any of { title, body, agent_id, status,
                                                      priority, metadata }
                                       agent role: only tasks where agent_id == principal_id;
                                                   only status + metadata fields

DELETE /v1/tasks/:id                — soft delete (member|owner|connector)

POST   /v1/tasks/:id/comments       — append comment
GET    /v1/tasks/:id/comments       — list with cursor pagination
```

### External refs

```
POST   /v1/external_refs            — link a resource to an external id
                                       body: { resource_type, resource_id, source_kind,
                                               source_id, external_id, external_url?,
                                               metadata? }
                                       agent role: source_id must equal principal_id

GET    /v1/external_refs            — query with filters
                                       query: resource_type, resource_id, source_kind,
                                              source_id, external_id, cursor, limit

DELETE /v1/external_refs/:id        — soft delete
```

### Deferred (v1.1+)

```
GET    /v1/events?since=&limit=&resource_type=     — the change log API
POST   /v1/tasks/:id/heartbeat                     — long-running keep-alive
GET    /v1/stream/events                           — SSE push
POST   /v1/users                                   — direct user CRUD (UI work)
```

---

## Task lifecycle

```
              pending ──assign──► assigned
                                      │
                                      │ agent starts
                                      ▼
                                  in_progress ◄──┐
                                      │          │
                ┌─────────────────────┼──────────┘
                │                     │
            blocked                completed
                │                     │
           unblock                 (terminal)
                │
                ▼
            in_progress
```

Statuses:
- `pending` — created, not yet assigned to an agent.
- `ready` — has `agent_id` set and is waiting for the agent to pick it up. Agents poll `?status=ready`.
- `in_progress` — agent has claimed it (PATCH status=in_progress sets `started_at`).
- `blocked` — agent surfaced an ambiguity; needs human input. Optional `metadata.block_reason`.
- `completed` — terminal. Sets `completed_at`.
- `failed` — terminal. v1: only set explicitly by a human or by the agent itself. v1.1+: may be set by system after N consecutive `blocked` cycles. Optional `metadata.failure_reason`.
- `cancelled` — terminal. Set by user/owner to abandon a task.

(Single-vocabulary: we use `ready` everywhere, agent-side and user-side. Matches hermes's local kanban vocabulary too.)

State machine enforced in PATCH handler. Invalid transitions return `409` with `code: 'task.invalid_transition'`.

Every transition emits an `event` row with `kind = 'status_changed'` and `payload = { from, to }`.

---

## Error model

JSON envelope per response:

```json
{ "error": {
    "code": "task.not_found",
    "message": "Task t_abc not found in org o_xyz",
    "details": { "task_id": "t_abc" }
} }
```

| HTTP | Used for |
|---|---|
| 400 | Request shape invalid (Zod failure) |
| 401 | Missing / unparseable / unrecognized token |
| 403 | Token valid but role insufficient |
| 404 | Resource doesn't exist (or is soft-deleted and caller can't see soft-deleted) |
| 409 | Idempotency conflict OR state-machine violation OR duplicate slug/name |
| 422 | Semantic validation (e.g. assigning to a `deleted_at` agent) |
| 429 | Rate limit (v1.1+) |
| 500 | Server error — logged with request ID, returned without internals |

Error codes are stable dot-namespaced strings: `task.not_found`, `task.invalid_transition`, `auth.role_insufficient`, `idempotency.conflict`, etc. The error code map is exported as part of the SDK (v1.1).

---

## Idempotency

Two layers, each serving a distinct purpose:

**Layer 1 — Generic API-level idempotency (Stripe-style):**
- Caller sends `Idempotency-Key: <opaque-string>` header on `POST /v1/tasks` and `POST /v1/external_refs`.
- Server stores `(org_id, route, key) → (status, body)` in `idempotency_keys` with 24h TTL.
- Repeat request with same key + same body = returns cached response.
- Repeat with same key + *different* body = `409 idempotency.conflict`.
- Useful for retries on flaky networks.

**Layer 2 — Semantic dedup via `tasks.idempotency_key`:**
- Caller sets `idempotency_key: "notion:<page_id>:<version>"` in the request body.
- Partial unique index `(org_id, idempotency_key) WHERE deleted_at IS NULL` enforces uniqueness for active rows.
- Insert collision → `409 idempotency.conflict` with the existing task id in `details.existing_task_id`.
- Survives expiration of the Layer 1 cache. Recreatable after soft-delete (the partial index excludes deleted rows).

---

## Pagination

All list endpoints use **opaque cursor pagination**:

```
GET /v1/tasks?cursor=<opaque>&limit=50

→ {
    "data": [ ... ],
    "next_cursor": "<opaque-string-or-null>"
  }
```

Cursors encode `(updated_at, id)` base64'd. Stable under inserts because they encode an ordering position, not an offset. `null` next_cursor means end of results.

`limit` defaults to 50; max 100. Larger requests get clamped silently.

---

## Sync model (event log + cursors)

The `events` table is an append-only ordered change log. Every mutating handler emits a row (or rows) before returning. Event kinds:

- `task.created`, `task.updated`, `task.status_changed`, `task.deleted`
- `project.created`, `project.updated`, `project.deleted`
- `agent.created`, `agent.updated`, `agent.deleted`
- `comment.created`, `comment.deleted`
- `external_ref.added`, `external_ref.removed`

Consumers (Notion connector, hermes adapter, …) poll `GET /v1/events?since=<last_id>&limit=100` (v1.1 endpoint; schema active v1) and store their cursor client-side. Server-side cursors deferred to v1.1 — if/when admin visibility into consumer lag becomes a need.

**"Has this row been synced by me?"** answered by `external_refs` presence:

```sql
SELECT 1 FROM external_refs
WHERE org_id = ? AND resource_type = 'task' AND resource_id = ?
  AND source_kind = ? AND source_id = ? AND deleted_at IS NULL;
```

`external_refs.presence == synced`. No separate per-row sync-state table needed.

---

## Observability

- Every request gets a `cf-request-id` (Cloudflare-assigned) propagated into structured logs.
- Hono logger middleware emits one JSON line per request: `{ ts, request_id, method, path, status, ms, org_id, principal }`.
- Errors logged with full stack to stderr; Workers Logpush ships to wherever (R2 / external) in prod.
- Per-route latency histograms via Workers Analytics Engine (v1.1).

No external APM in v1. Workers' built-in observability covers the basics.

---

## Testing strategy

- **Unit tests** for: schema (Drizzle types compile), helpers (`active()`, cursor encode/decode), auth (token hashing, role checks).
- **Handler integration tests** with `@cloudflare/vitest-pool-workers`: each route gets a happy-path test + every error-code test. Tests run against a real D1 binding inside miniflare.
- **State-machine tests** for task transitions: matrix of (from, to) verifying allowed vs `409`.
- **Cascade tests** for soft-delete: assert child rows get cascaded, assert triggers fire on raw UPDATEs.
- **Multi-tenant isolation tests:** every test inserts two orgs, performs an operation in one, asserts the other org sees nothing. Catches missing `org_id` filters.
- **Migration tests** for `single` mode: apply all master + pool migrations to one DB, verify no errors.

Coverage gate: every route handler ≥ 80% line coverage; every soft-delete + cascade path has a regression test.

---

## Repo layout

```
services/mission-control/
  # hermes-stack scaffolding (deleted on extraction):
  service.env             # SERVICE_RUNNER=docker, MC_IMAGE_*, MC_ADMIN_TOKEN
  compose.yaml            # runs the Node build of the API
  build.sh                # builds the Docker image if needed

  # standalone-ready content (the project itself):
  src/
    index.ts              # Hono app factory; mounts better-auth at /v1/auth/*
    auth/
      config.ts           # better-auth instance with org + apiKey plugins
      middleware.ts       # session/PAT/M2M resolver → ctx
      roles.ts            # role → allowed-actions matrix
    routes/
      me.ts
      agents.ts           # wraps better-auth apiKey creation + agents table
      projects.ts
      tasks.ts
      comments.ts
      external-refs.ts
      health.ts
    db/
      master.ts           # Drizzle schema (incl. better-auth tables + tenant_pools)
      pool.ts             # Drizzle schema (agents, tasks, …)
      client.ts           # D1 / better-sqlite3 selector
      pool-resolver.ts    # orgId → pool binding (with TTL cache)
      helpers.ts          # active(), withOrg(), …
      cascade.ts          # deleteResource helpers
    events/
      emit.ts             # one function per event kind
    errors.ts             # error code map + Response helpers
    pagination.ts         # cursor encode/decode
    validation/
      schemas.ts          # Zod schemas
  migrations/
    master/
      0001_better_auth.sql      # generated by @better-auth/cli generate
      0002_org_custom_fields.sql # tenantPoolId, plan, deletedAt on organization
      0003_tenant_pools.sql
    pool/
      0001_init.sql
  scripts/
    bootstrap.ts          # first user + first org via better-auth admin API
    seed-dev.ts           # local-dev seed data
  test/
    helpers/
      auth.ts             # signUp(), createOrg(), mintAgentKey() helpers
    routes/
  wrangler.toml
  Dockerfile              # Node build for self-hosters
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
  LICENSE                 # MIT
  docs/
    specs/
      2026-05-22-master-api-design.md   # this file
    plans/
```

---

## What v1 ships

- ✅ Worker deployable to Cloudflare with master + 1 pool D1
- ✅ Self-host as a Docker image (Node + SQLite)
- ✅ Bootstrap script that mints an org + owner key
- ✅ All v1 routes listed above, with auth + role enforcement + soft-delete + cascade
- ✅ Events table populated by every mutating handler
- ✅ Polymorphic external_refs with both the join-table queries you asked about
- ✅ Idempotency (both layers)
- ✅ Test suite per the strategy above

**End-to-end demonstration (no UI, no hermes integration):**

```
$ mc-bootstrap   → creates first user (you@acme.com) + org "Acme" + prints PAT
                   ($MC_PAT for subsequent calls)

$ curl -H "Authorization: Bearer $MC_PAT" POST /v1/projects \
       -d '{name:"Test", slug:"test"}'

$ curl -H "Authorization: Bearer $MC_PAT" POST /v1/agents \
       -d '{name:"hermes-vm1", kind:"hermes"}'
       → returns { agent: {...}, key: "mc_agent_..." } — capture as $MC_AGENT_KEY

$ curl -H "Authorization: Bearer $MC_PAT" POST /v1/tasks \
       -d '{project_id:..., title:"Hello", agent_id:"<agt-id>"}'

# Now simulate the agent:
$ curl -H "Authorization: Bearer $MC_AGENT_KEY" GET /v1/tasks?status=ready
$ curl -H "Authorization: Bearer $MC_AGENT_KEY" PATCH /v1/tasks/<id> \
       -d '{status:"in_progress"}'
$ curl -H "Authorization: Bearer $MC_AGENT_KEY" POST /v1/external_refs \
       -d '{resource_type:"task", resource_id:..., source_kind:"hermes",
             source_id:"hermes-vm1", external_id:"t_abc_local"}'
$ curl -H "Authorization: Bearer $MC_AGENT_KEY" POST /v1/tasks/<id>/comments \
       -d '{body:"working on it"}'
$ curl -H "Authorization: Bearer $MC_AGENT_KEY" PATCH /v1/tasks/<id> \
       -d '{status:"completed"}'
```

This validates the whole architecture before any agent or connector integration begins.

---

## What's deliberately deferred

| Item | Why deferred |
|---|---|
| `task_links` (parent/child) | Subtask graphs stay in agents' local kanbans per the design principle. |
| `task_runs` | Master tracks final outcome; agents track retries locally. |
| `GET /v1/events` endpoint | First consumer (Notion connector) is v1.1; expose API at the same time. |
| Heartbeat endpoint | `tasks.updated_at` is a sufficient proxy for v1 cadences. |
| SSE / WebSockets | Polling at 30s is free and dead-simple to debug; add streaming when latency matters. |
| Server-side cursors | Client-side is sufficient until multi-instance consumers or admin lag visibility need it. |
| Fine-grained scopes | Coarse roles cover v1; add scope strings when an integration genuinely needs less than `connector`. |
| User CRUD via API | Bootstrap script + direct DB v1; user-API arrives with the custom UI work. |
| Webhooks out | Pull (event log) is enough for v1. |
| Per-tenant D1 (sharded pools) | Schema supports it via `tenant_pool_id`; ops setup waits for the first paying customer. |
| Billing / metering / rate limits | `orgs.plan` exists; enforcement waits for SaaS launch. |
| Notion connector | Separate spec — `2026-MM-DD-notion-connector-design.md`. |
| Hermes adapter | Separate spec — `2026-MM-DD-hermes-adapter-design.md`. |

---

## Open questions for review

1. **Failure handling for spawn-style operations:** when an agent's `consecutive_failures` would hit a limit, who decides the action? In Hermes's local kanban the dispatcher auto-blocks. In the master, there's no dispatcher — only the agent itself reports. v1 leaves this to convention (agent calls PATCH status=blocked); we may add server-side detection v1.1.
2. **Migration of org between pools:** schema supports updating `organization.tenantPoolId`, but moving data between pools is non-trivial (cross-DB copy). Out of scope v1; document as ops procedure when first needed.
3. **Better-auth migration cadence:** when better-auth ships schema updates we'll need to apply them via `@better-auth/cli generate`. We commit the generated SQL — but coordinated upgrades across multiple pool deployments is an ops concern to document.
