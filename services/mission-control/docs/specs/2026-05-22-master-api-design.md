# MissionControl — Master API Design

**Status:** Draft for review
**Date:** 2026-05-22
**Scope:** v1 of the Master API service (`services/mission-control/`).

This spec covers the central task-coordination API only. Notion connector, hermes adapter, claude adapter, and custom UI each get their own design spec.

---

## Goal

A single API that lets a user create projects and tasks, assigns them to **agent instances** (Hermes VMs, Claude sessions, OpenClaw runs, …), tracks status as agents work, and exposes a unified change log that external systems (Notion, Linear, custom dashboards) can sync against bidirectionally.

The user's mental model: _"I'm creating a task in Notion (or our UI) and assigning it to one of my agents. I want to see the status update in Notion as the agent works."_ How the agent decomposes and executes the work internally (subagents, swarms, local kanban) is not the master's concern.

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

|             | Production (SaaS)        | Self-hosted (OSS)                                       | Contributor dev           |
| ----------- | ------------------------ | ------------------------------------------------------- | ------------------------- |
| Runtime     | Cloudflare Workers       | `wrangler dev` (Docker container)                       | `wrangler dev` directly   |
| Database    | D1 (sharded — see below) | Local SQLite via D1 (`wrangler dev --persist-to /data`) | Local SQLite via wrangler |
| Cron        | Cloudflare Cron Triggers | Wrangler cron simulation                                | n/a v1                    |
| Push (v1.1) | Streaming Response (SSE) | Same                                                    | Same                      |

One Hono codebase, one runtime (Cloudflare Workers / wrangler). Driver selection removed; all paths use `drizzle-orm/d1`.

---

## Storage architecture

### Two-tier D1 (production)

```
┌──────────────────────────────────────────────────────────┐
│  MASTER (D1 #0)  — better-auth + small custom            │
│  ───────────────                                         │
│  user, session, account, verification     (better-auth)  │
│  organization (+tenantPoolId, plan,                      │
│                deletedAt additional fields) (better-auth)│
│  member, invitation                       (better-auth)  │
│  apiKey (+orgId, principalType additional               │
│          fields; metadata for agent_id/                  │
│          connector_id references)         (better-auth)  │
│  tenant_pools  (id, binding_name)         (custom)       │
└────────────────────────┬─────────────────────────────────┘
                         │  organization.tenantPoolId
                         ▼
┌──────────────────────────────────────────────────────────┐
│  POOL_DEFAULT (D1 #1)   ← v1: every org lives here       │
│  ──────────────────                                      │
│  agents          (id, org_id, name, kind, last_seen_at)  │
│  connectors      (id, org_id, name, kind, last_seen_at)  │
│  projects        (id, org_id, name, slug, …)             │
│  tasks           (id, org_id, project_id, agent_id, …)   │
│  task_comments   (id, org_id, task_id, author_*, body)   │
│  events          (id, org_id, resource_*, kind, payload) │
│  external_refs   (id, org_id, resource_*, source_*, …)   │
│  idempotency_keys(org_id, route, key, response)          │
└──────────────────────────────────────────────────────────┘

Future:
  POOL_PREMIUM_ACME (D1 #2)   ← dedicated to one paying org
  POOL_SHARDED_001  (D1 #3)   ← spillover for new free-tier signups
```

**Why two tiers:** the api-key lookup must happen _before_ we know which pool to query, so identity & routing have to live in a fixed-location master. Everything else is pool-scoped task data and can be sharded.

**Why pre-declared bindings (not dynamic D1 HTTP API):** Workers can't create bindings at runtime, but a small registry mapping `tenantPoolId → env.POOL_X` lets us pick the right binding per request at native-binding latency. Adding a new pool = `wrangler d1 create` + add to `wrangler.toml` + deploy. Ops event, not hot path.

**Why org-level pool (not user-level):** orgs are the data-sharing boundary. Two users in one org must see each other's tasks, so they must be in the same pool. `tenantPoolId` lives on `organization` (better-auth additional field).

### Single-DB mode (self-hosted / local dev)

For OSS self-hosters and local contributors, **DB_MODE is always `single`**. SaaS production is always `split`. We do not support a self-hoster running split-mode or a SaaS deployment running single-mode — that drift gets messy fast.

In `single` mode:

- One D1 binding named `DB` (local SQLite file managed by `wrangler dev`).
- Both `migrations/master/*` and `migrations/pool/*` apply to the same `DB`, in numeric order interleaved per source. Since table names don't collide (no `tasks` in master, no `organization` in pool), they coexist cleanly.
- `POOL_BINDING_MAP['default']` resolves to `env.DB` — same binding the master client uses. Pool resolver returns the same Drizzle client. Zero branching in handlers.
- `tenant_pools` registry table still exists; it's seeded with a single row `('default', 'DB')` and isn't user-extensible self-host. No-op for OSS but keeps schema parity with SaaS.

In `split` mode:

- Bindings: `MASTER_DB`, `POOL_DEFAULT`, and (later) `POOL_PREMIUM_*`, etc.
- `migrations/master/*` applies to `MASTER_DB`. `migrations/pool/*` applies independently to each `POOL_*` binding.
- The resolver maps `organization.tenantPoolId → env.POOL_X` per request.

The `db/client.ts` resolver returns `{ master, pool }` Drizzle clients per request. Mode chosen at boot from `DB_MODE` env (default `single` for safety on first-run OSS).

---

## Stack

| Concern        | Choice                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- |
| HTTP framework | Hono — runs on Workers, Node, Bun, Deno                                                  |
| Database       | D1 (Workers) — local SQLite via wrangler for self-host                                   |
| ORM            | Drizzle (`drizzle-orm/d1`)                                                               |
| Migrations     | SQL files via `wrangler d1 migrations` + Drizzle's migrator                              |
| Validation     | Zod (on every request body and query param)                                              |
| Auth           | **better-auth** with `organization` + `apiKey` plugins (Drizzle adapter, master DB only) |
| Logging        | Hono's logger middleware + structured JSON to stderr (CF gives us this for free)         |
| Testing        | Vitest + `@cloudflare/vitest-pool-workers`                                               |

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

All bearer tokens come from better-auth's apiKey plugin. Better-auth supports a per-key `prefix` parameter at creation, which we use to encode the type for human-scannable tokens:

```
mcpat_<bytes>      — personal access token (PAT) for a human user
mcagt_<bytes>      — agent key (machine credential bound to an agents row)
mccnn_<bytes>      — connector key (machine credential bound to a connectors row)
```

The prefix is **informational only**. The source of truth for authorization is `apiKey.permissions` and `apiKey.metadata.type` — middleware never trusts the prefix for routing decisions. Tokens are shown to the caller once at creation; only better-auth's hashed value + display prefix are stored.

(Short concatenated prefixes like `mcpat_` instead of `mc_pat_` keep token length tighter and scan more cleanly in logs / leak detectors.)

### Principal model

The credential (api key) is **always owned by a user** (better-auth requires `userId`). The _actor_ the system reasons about is determined by `metadata.type`:

| `metadata.type` | Acts as                                                  | Bound to entity         |
| --------------- | -------------------------------------------------------- | ----------------------- |
| `'pat'`         | The human user themselves (full role from `member.role`) | —                       |
| `'agent'`       | An agent in the `agents` table                           | `metadata.agent_id`     |
| `'connector'`   | A connector (registered via `POST /v1/connectors`)       | `metadata.connector_id` |

This is the GitHub-Apps / Slack-bots / Notion-integrations pattern: the credential happens to be owned by a user for audit + revocation, but the actor recorded in events / accessible to handlers is the agent or connector. **Agents are not users.** Agent identity lives in the `agents` table (in pool DB); the api key in master is just the credential.

### Role model

Human roles come from better-auth's organization plugin (per `member.role`):

| role     | Scope                                                                                    |
| -------- | ---------------------------------------------------------------------------------------- |
| `owner`  | Everything in their org. Manage members, billing, api_keys, agents, projects, all tasks. |
| `admin`  | Same as owner except no billing, no removing other admins/owners.                        |
| `member` | Create/edit projects, tasks, comments. Mint agent keys. No org admin.                    |

Machine roles (set via `metadata.type` on the api key):

| role        | Scope                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`     | Read tasks where `agent_id == metadata.agent_id`. Update those tasks (status + metadata only). Post `external_refs` where `source_id == metadata.agent_id`. Post comments on own tasks. Heartbeats (v1.1). |
| `connector` | Full task & project CRUD across the org. Read `events`. Write `external_refs` where `source_id == metadata.connector_id`.                                                                                  |

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
  default: 'POOL_DEFAULT',
  'premium-acme': 'POOL_PREMIUM_ACME',
  // … added per provisioning event; deployed via wrangler.toml + this map
}

async function resolvePoolForOrg(env: Env, orgId: string): Promise<DrizzleClient> {
  const tenantPoolId = await orgPoolCache.get(orgId, async () => {
    const org = await master(env).query.organization.findFirst({
      where: eq(organization.id, orgId),
      columns: { tenantPoolId: true },
    })
    if (!org) throw new HttpError(404, 'auth.org_not_found')
    return org.tenantPoolId
  })
  const binding = env[POOL_BINDING_MAP[tenantPoolId]]
  if (!binding) throw new HttpError(500, 'pool.binding_missing')
  return drizzle(binding, { schema: poolSchema })
}
```

In single-DB mode: `POOL_BINDING_MAP['default'] === 'DB'` — same binding master uses. Resolver returns the same physical client. Zero branching in handlers.

### Bootstrap

For SaaS: better-auth's signup flow handles first-user creation; the first user creates their org via the organization plugin's API; better-auth assigns `member.role='owner'` automatically. From there they mint agent keys via `POST /v1/agents`.

For self-host: an **in-process startup hook** runs on every Worker boot:

1. Check if any `user` row exists in master. If yes → no-op, continue.
2. If no users AND `MC_ADMIN_TOKEN` env var is set → expose a one-time `POST /v1/bootstrap` endpoint that takes `{email, password, org_name}` + the admin token in header, creates the first user + first org via better-auth's server-side API, returns the user's first PAT.
3. The endpoint disables itself once any user exists (the same first-check shuts the gate).
4. If no users AND no `MC_ADMIN_TOKEN` set → the Worker refuses to start, logs an instructive error pointing at the docs.

This avoids the chicken-and-egg "no user can sign up without a UI" without needing a separate CLI process that talks to a running Worker.

For local dev: `pnpm seed:dev` calls the same `/v1/bootstrap` against `wrangler dev` + sets up a demo org with example agents/connectors/projects.

**Amendment 2026-05-24 (MC UI v1):**

1. The API mount prefix moved from `/v1/*` to `/api/v1/*` so the `/api/` prefix can form a clean boundary with the SPA fallthrough served by Workers Assets. Every endpoint listed below — including `/v1/bootstrap`, `/v1/auth/*`, etc. — now lives under `/api/v1/...`. The Hermes plugin's `HERMES_MC_URL` env var convention is the base URL _up to but excluding_ `/v1/` (so combined-deploy values become `https://mc.example.com/api`; subdomain-deploy values stay `https://api.example.com`).
2. The `/api/v1/bootstrap` handler now marks the user it creates as `emailVerified: true`. The UI enables `requireEmailVerification: true` in better-auth's config, so a non-pre-verified bootstrap user would be locked out of sign-in. Operators presenting `MC_ADMIN_TOKEN` are implicitly verifying the email they type.

Both changes ship with the MC UI v1 work; see [`docs/specs/2026-05-24-mc-ui-design.md`](../../../../docs/specs/2026-05-24-mc-ui-design.md).

---

## Schema (v1)

**Standard columns** (apply to all tables EXCEPT where noted in the exemptions below):

- `id` (string, slug-prefixed: `org_…`, `usr_…`, `t_…`, `prj_…`, etc.)
- `created_at` (integer, ms since epoch)
- `updated_at` (integer, ms since epoch; bumped on every mutation via Drizzle `$onUpdate` AND by a SQLite trigger so raw SQL paths bump too)

**User-mutable tables additionally include** (soft-delete columns):

- `deleted_at` (integer nullable; NULL = active)
- `deleted_by_type` (`'user'|'agent'|'connector'|'system'`)
- `deleted_by_id` (string)

**Exemptions from soft-delete (and standard-column variations):**

- `events` — append-only audit log; no `updated_at`, no `deleted_at`. Retention purged on schedule (v1: 365d default, configurable).
- `idempotency_keys` — composite PK `(org_id, route, key)` instead of `id`; no `updated_at`; TTL-purged via `expires_at` instead of soft-delete.
- `apiKey`, `session`, `account`, `verification`, `invitation` — better-auth-managed; use their own lifecycle fields (see auth section).

### Master DB

**Better-auth-managed tables** (schema produced via the better-auth → drizzle-kit migration pipeline below, committed under `migrations/master/`):

```
1. @better-auth/cli generate         → produces src/db/master.ts (Drizzle TS schema, NOT SQL)
2. drizzle-kit generate              → reads master.ts, writes migrations/master/NNNN_*.sql
3. wrangler d1 migrations apply DB   → applies SQL to D1
```

Step 1 is run any time better-auth's schema changes (new plugin, upgraded version, our `additionalFields` change). Step 2 produces a diff migration. Step 3 ships it. Pin the better-auth version in package.json so step 1 is deterministic.

The tables generated:

- `user` — id, email, emailVerified, name, image, createdAt, updatedAt
- `session` — id, userId, expiresAt, token, ipAddress, userAgent, activeOrganizationId, createdAt, updatedAt
- `account` — id, userId, accountId, providerId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt
- `verification` — id, identifier, value, expiresAt, createdAt, updatedAt
- `organization` — id, name, slug, logo, createdAt, metadata, **+ custom field** `tenantPoolId`
- `member` — id, organizationId, userId, role ('owner'|'admin'|'member'), createdAt
- `invitation` — id, organizationId, email, role, status, expiresAt, inviterId
- `apiKey` — id, name, start, prefix, key (hashed), userId, refillInterval, refillAmount, lastRefillAt, enabled, rateLimitEnabled, rateLimitTimeWindow, rateLimitMax, requestCount, remaining, lastRequest, expiresAt, createdAt, updatedAt, permissions (JSON), metadata (JSON)

Custom fields added via better-auth's schema extension mechanism (both `organization` and `apiKey` get `additionalFields`):

```typescript
plugins: [
  organization({
    schema: {
      organization: {
        additionalFields: {
          tenantPoolId: { type: 'string', required: true, defaultValue: 'default' },
          plan: { type: 'string', required: true, defaultValue: 'free' },
          deletedAt: { type: 'date', required: false },
        },
      },
    },
  }),
  apiKey({
    schema: {
      apiKey: {
        additionalFields: {
          // Promoted from metadata to typed columns for indexed lookups + admin
          // queries. agent_id / connector_id stay in metadata (low cardinality).
          orgId: { type: 'string', required: true },
          principalType: { type: 'string', required: true }, // 'pat'|'agent'|'connector'
        },
      },
    },
  }),
]
```

`apiKey.metadata` (JSON) holds the low-cardinality entity references:

```json
{
  "agent_id": "agt_xxx", // when principalType='agent'
  "connector_id": "cnn_xxx" // when principalType='connector'
}
```

Indexed lookups on `(apiKey.orgId, apiKey.principalType)` work via typed columns; `agent_id`/`connector_id` resolution is a single-row metadata read off the same apiKey row.

### Pool-DB tenant isolation

Every pool DB query MUST be scoped by `org_id`. We enforce this through three layered defenses, in order of strength:

1. **Strong: a typed query helper** (`withOrg(ctx).from(tasks)…`) that auto-injects `WHERE org_id = ctx.orgId` on selects and rejects inserts missing `org_id`. Used for 100% of route-handler queries.
2. **Medium: mandatory multi-tenant isolation tests.** Every route handler test inserts two orgs, performs the operation in one, asserts the other org sees nothing. Lifted to a Vitest matcher (`expect(handler).toBeIsolated()`) so it's enforced by the test runner, not by discipline.
3. **Weak but real: a CI lint rule** that flags raw `db.run(sql\`…\`)`or`db.select().from(t).where(…)` calls that don't go through the helper. Allowlisted exceptions for migration scripts and admin tools.

We do NOT promise compile-time guarantees that org leakage is impossible — Drizzle's query builder is dynamic enough that a determined developer can bypass the helper. The combination of helper + tests + lint catches the realistic mistake patterns.

**Custom master tables (not managed by better-auth):**

```sql
CREATE TABLE tenant_pools (
  id            TEXT PRIMARY KEY,        -- 'default', 'premium-acme', 'sharded-001'
  binding_name  TEXT NOT NULL,           -- 'POOL_DEFAULT', 'POOL_PREMIUM_ACME', ...
  created_at    INTEGER NOT NULL
);
```

Tenant_pools is a simple registry — the routing table the Worker consults to map `organization.tenantPoolId` to a binding name. Seeded with `('default', 'POOL_DEFAULT')` at install.

Note: organization soft-delete uses the `deletedAt` custom field above. Better-auth's session/account/verification/apiKey/invitation tables don't get soft-delete — they use their built-in lifecycle fields:

- `apiKey.enabled` (boolean) + `apiKey.expiresAt` together cover revocation. To "revoke" a key, set `enabled=false`.
- `session.expiresAt` covers session invalidation.
- `verification.expiresAt` covers expiring email-verification / password-reset tokens.
- `invitation.status` ('pending'|'accepted'|'expired'|'cancelled') covers invitation lifecycle.

### Pool DB

```sql
CREATE TABLE agents (
  id                  TEXT PRIMARY KEY,                  -- 'agt_xxx'
  org_id              TEXT NOT NULL,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL,                     -- 'hermes'|'claude'|'openclaw'|...
  description         TEXT,
  last_seen_at        INTEGER,                           -- NULL v1; populated by heartbeat in v1.1
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

-- Mirror of agents for bidirectional-sync external systems (Notion, Linear, …).
-- Same lifecycle, separate table for clarity in queries and admin tooling.
CREATE TABLE connectors (
  id                  TEXT PRIMARY KEY,                  -- 'cnn_xxx'
  org_id              TEXT NOT NULL,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL,                     -- 'notion'|'linear'|'github'|'custom'
  description         TEXT,
  last_seen_at        INTEGER,                           -- bumped by middleware when key used (v1)
  created_by_user_id  TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  deleted_by_type     TEXT,
  deleted_by_id       TEXT
);
CREATE UNIQUE INDEX connectors_name_per_org_active
  ON connectors(org_id, name) WHERE deleted_at IS NULL;
CREATE INDEX connectors_org_kind_active
  ON connectors(org_id, kind) WHERE deleted_at IS NULL;

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

-- Layer-2 semantic dedup. Callers MUST namespace their key by their full
-- source identity (e.g. "notion:<workspace_id>:<page_id>" not just
-- "notion:<page_id>") to prevent collisions between different connector
-- instances of the same kind. Documented in the API reference.
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

-- Append-only audit log. Never soft-deleted; purged on retention schedule.
-- v1 retention: 365 days (configurable per org plan in v1.1). Nightly Cron
-- Trigger does `DELETE FROM events WHERE created_at < now - 365d`.
-- NOTE: events.id is monotonic per pool DB. v1 has one pool so a single
-- cursor works. When sharded pools land (v1.1+), consumers reading events
-- from multiple pools need either per-pool cursors or a composite cursor
-- (pool_id, event_id). Document at the v1.1 events-API rollout.
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic per pool DB
  org_id          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,                     -- 'task'|'project'|'agent'|'connector'|'comment'
  resource_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,                     -- see kinds + payload schemas below
  actor_type      TEXT,                              -- 'user'|'agent'|'connector'|'system'
  actor_id        TEXT,
  payload         TEXT,                              -- JSON, kind-specific (see schemas below)
  created_at      INTEGER NOT NULL
);
CREATE INDEX events_org_id ON events(org_id, id);
CREATE INDEX events_resource ON events(org_id, resource_type, resource_id);

CREATE TABLE external_refs (
  id              TEXT PRIMARY KEY,                  -- 'xrf_xxx'
  org_id          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,                     -- 'task'|'project'|'agent'|'connector'|'comment'
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
   await deleteResource(db, ctx, { type: 'task', id })
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
import { isNull, and, eq } from 'drizzle-orm'
export const active = <T extends { deletedAt: Column }>(t: T) => isNull(t.deletedAt)

db.select()
  .from(tasks)
  .where(and(eq(tasks.orgId, ctx.orgId), active(tasks)))
```

Convention: every read of a soft-deletable table goes through `active()`. CI lint rule enforces (v1). See "Pool-DB tenant isolation" in the auth section for the layered enforcement of `WHERE org_id = ?`.

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

Permission notation: `(owner|admin|member)` lists the human roles allowed; `admin` is always allowed wherever `member` is allowed. `connector` / `agent` are listed explicitly when relevant.

```
GET    /v1/health                   — liveness; returns 200 unconditionally
GET    /v1/health/ready             — readiness; pings master + pool, returns 200 or 503

GET    /v1/me                       — current resolved principal + org info
                                       returns { org, principal_type, principal_id, role,
                                                 pool_id, agent? | connector? }
                                       (agent/connector blocks include name, kind, last_seen_at
                                        when principal_type is 'agent' or 'connector')

POST   /v1/agents                   — register an agent (owner|admin|member)
                                       body: { name, kind, description? }
                                       response: { agent: {...}, key: 'mcagt_...' }
                                       (saga: insert agent → mint better-auth apiKey;
                                        full key shown once, never stored)
GET    /v1/agents                   — list
GET    /v1/agents/:id
PATCH  /v1/agents/:id
DELETE /v1/agents/:id               — soft delete; 409 if active tasks (owner|admin)
POST   /v1/agents/:id/rotate-key    — revoke old key, mint new (owner|admin)

POST   /v1/connectors               — register a connector (owner|admin)
                                       body: { name, kind, description? }
                                       response: { connector: {...}, key: 'mccnn_...' }
                                       (same saga pattern as agents)
GET    /v1/connectors               — list
GET    /v1/connectors/:id
PATCH  /v1/connectors/:id
DELETE /v1/connectors/:id           — soft delete; 409 if active tasks (owner|admin)
POST   /v1/connectors/:id/rotate-key — revoke old key, mint new (owner|admin)
```

Note: agent-key and connector-key minting are wrapped by mission-control (not exposed directly via better-auth) because the operation spans two databases (pool DB for the `agents`/`connectors` row, master DB for the better-auth `apiKey` row). D1 has no cross-database transactions, so the handler runs a **saga**:

1. INSERT into `pool.agents` (or `pool.connectors`) → get the new id.
2. Call `auth.api.createApiKey({ userId, prefix: 'mcagt_'|'mccnn_', orgId, principalType: 'agent'|'connector', metadata: { agent_id|connector_id }, permissions: ['agent', `agent:${id}`] })`.
3. If step 2 fails, compensating action: soft-delete the just-inserted row with `deleted_by_type='system'` and surface the apiKey error to the caller. `409`/`500` depending on cause.
4. Return `{ agent|connector, key }`. Token shown once.

The window between step 1 and step 2 is observable (a half-created agent without a key) only via direct pool DB read; no API route exposes deleted agents, and the saga completes within one Worker request (sub-100ms typical). Compensating action prevents long-term drift.

### Agent / connector soft-delete with live tasks

A `DELETE /v1/agents/:id` (or `connectors/:id`) checks for assigned non-terminal tasks first:

- If any `tasks` exist with `agent_id == :id` AND `status IN ('ready','in_progress','blocked')` AND `deleted_at IS NULL` → return `409 agent.has_active_tasks` with `details.task_ids` listed. Caller must reassign or cancel those tasks first.
- Otherwise: soft-delete the agent, emit `agent.deleted` event.

This prevents tasks pointing at a tombstone agent. Reassign (PATCH task.agent_id) is the explicit path; cancel (PATCH task.status='cancelled') is the alternative.

### Projects

```
POST   /v1/projects                 — create (owner|admin|member|connector)
GET    /v1/projects                 — list (any human role + connector)
GET    /v1/projects/:id
PATCH  /v1/projects/:id             — (owner|admin|member|connector)
DELETE /v1/projects/:id             — soft delete (owner|admin|connector)
```

### Tasks

```
POST   /v1/tasks                    — create (owner|admin|member|connector)
                                       body: { project_id, title, body?, agent_id?,
                                               priority?, metadata?, idempotency_key? }
                                       header: Idempotency-Key (optional)
                                       NOTE: idempotency_key MUST be namespaced by the
                                       caller (e.g. "notion:<workspace_id>:<page_id>:v1");
                                       cross-connector collisions are caller's responsibility

GET    /v1/tasks                    — list with filters (any role)
                                       query: project_id, agent_id, status, updated_since,
                                              cursor, limit (max 100)
                                       agent role: forced agent_id=principal_id

GET    /v1/tasks/:id                — detail
                                       includes recent comments + recent events (latest 20 each)

PATCH  /v1/tasks/:id                — update
                                       body: any of { title, body, agent_id, status,
                                                      priority, metadata }
                                       (owner|admin|member|connector for all fields)
                                       (agent role: only tasks where agent_id == principal_id;
                                        only status + metadata fields)

DELETE /v1/tasks/:id                — soft delete (owner|admin|connector)

POST   /v1/tasks/:id/comments       — append comment (any role)
GET    /v1/tasks/:id/comments       — list with cursor pagination (any role)
```

### External refs

```
POST   /v1/external_refs            — link a resource to an external id
                                       body: { resource_type, resource_id, source_kind,
                                               source_id, external_id, external_url?,
                                               metadata? }
                                       agent role: source_id must equal principal_id
                                       connector role: source_id must equal principal_id

GET    /v1/external_refs            — query with filters (any role)
                                       query: resource_type, resource_id, source_kind,
                                              source_id, external_id, cursor, limit

DELETE /v1/external_refs/:id        — soft delete (owner|admin|connector or owning agent)
```

### Events

```
GET    /v1/events                   — change log read API (owner|admin|member|connector)
                                       query: since (integer event id, exclusive lower
                                              bound; default 0)
                                              kinds (comma-separated resource_type
                                                values to include; default all)
                                              limit (1-200; default 100)
                                              cursor (opaque; for forward-paging
                                                within a single since-window when
                                                more than `limit` events accumulated)
                                       response: {
                                         events: [{ id, org_id, resource_type,
                                                    resource_id, kind, actor_type,
                                                    actor_id, payload, created_at }],
                                         next_cursor: <opaque|null>
                                       }
                                       agent role excluded: events carry resource
                                       data across the whole org, and agent-role
                                       visibility is per-row (agent_id == self).
                                       Per-row event visibility would require joining
                                       events to the underlying resource on every
                                       read — expensive. Connector role (full org
                                       read access) is the appropriate consumer.
                                       Plugins / connectors using events stream:
                                       authenticate with their connector key and
                                       filter client-side by the payload.
```

The `events.id` cursor is **integer-monotonic per pool**. v1 has one pool, so a single integer cursor is sufficient. Consumers save the highest `id` seen and pass it back as `since` on the next poll. `next_cursor` is used only when a since-window itself spans more than `limit` events — set `since = highest event id seen` on the next call and `cursor` returns to null. For the v1.1+ sharded-pool case, a composite cursor `(pool_id, event_id)` will be introduced (documented at the v1.1 rollout).

Event kinds and payload shapes are documented in §"Sync model" below. Polling consumers should be tolerant of unknown kinds (skip them) so MC can add new kinds without breaking older consumer versions.

### Deferred (v1.1+)

```
POST   /v1/tasks/:id/heartbeat                     — long-running keep-alive
GET    /v1/stream/events                           — SSE push (events stream over EventSource)
POST   /v1/users                                   — direct user CRUD (UI work)
```

---

## Task lifecycle

```
              pending ───assign────► ready
                  │                    │
                  │                    │ agent claims
                  │                    ▼
                  │                in_progress ◄────┐
                  │                    │            │
                  │       ┌────────────┼────────────┘
                  │       │            │
                  │   blocked      completed (terminal)
                  │       │
                  │   unblock
                  │       │
                  │       ▼
                  │   in_progress
                  │
                  └─────────────────► cancelled (terminal)

              anywhere ─────────────► failed (terminal)
```

Statuses:

- `pending` — created, not yet assigned to an agent (`agent_id IS NULL`).
- `ready` — `agent_id` is set; waiting for the agent to claim. Agents poll `?status=ready`.
- `in_progress` — agent has claimed it (PATCH `status=in_progress` sets `started_at`).
- `blocked` — agent surfaced an ambiguity; needs human input. Optional `metadata.block_reason`.
- `completed` — terminal. Sets `completed_at`.
- `failed` — terminal. v1: only set explicitly by a human or by the agent itself. v1.1+: may be set by system after N consecutive `blocked` cycles. Optional `metadata.failure_reason`.
- `cancelled` — terminal. Set by user/owner/admin to abandon a task.

**Invalid transitions return `409 task.invalid_transition`.** In particular, transitions FROM a terminal state (`completed`, `failed`, `cancelled`) are always rejected — undo is `DELETE` (soft-delete) + recreate, not "un-complete."

(Single-vocabulary: we use `ready` everywhere, agent-side and user-side. Matches hermes's local kanban.)

State machine enforced in PATCH handler. Invalid transitions return `409` with `code: 'task.invalid_transition'`.

Every transition emits an `event` row with `kind = 'status_changed'` and `payload = { from, to }`.

---

## Error model

JSON envelope per response:

```json
{
  "error": {
    "code": "task.not_found",
    "message": "Task t_abc not found in org o_xyz",
    "details": { "task_id": "t_abc" }
  }
}
```

| HTTP | Used for                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 400  | Request shape invalid (Zod failure)                                                                    |
| 401  | Missing / unparseable / unrecognized token                                                             |
| 403  | Token valid but role insufficient                                                                      |
| 404  | Resource doesn't exist (or is soft-deleted and caller can't see soft-deleted)                          |
| 409  | Idempotency conflict OR state-machine violation OR duplicate slug/name OR active-tasks-blocking-delete |
| 422  | Semantic validation (e.g. assigning to a `deleted_at` agent)                                           |
| 429  | Rate limit                                                                                             |
| 500  | Server error — logged with request ID, returned without internals                                      |
| 503  | Pool binding missing (deployment skew between master DB + wrangler bindings); transient — retry-safe   |

Error codes are stable dot-namespaced strings: `task.not_found`, `task.invalid_transition`, `auth.role_insufficient`, `idempotency.conflict`, etc. The error code map is exported as part of the SDK (v1.1).

---

## Idempotency

Two layers, each serving a distinct purpose:

**Layer 1 — Generic API-level idempotency (Stripe-style):**

- Caller sends `Idempotency-Key: <opaque-string>` header on `POST /v1/tasks` and `POST /v1/external_refs`.
- Server stores `(org_id, route, key) → (status, body)` in `idempotency_keys` (D1 pool DB) with 24h TTL via `expires_at`.
- Repeat request with same key + same body = returns cached response.
- Repeat with same key + _different_ body = `409 idempotency.conflict`.
- Useful for retries on flaky networks.
- **Cost note:** every `POST /v1/tasks` writes one extra D1 row. At v1 scale (~10k tasks/day org) this is ~$1/month/org — acceptable. KV would be cheaper, but KV's eventual consistency is wrong for dedup (you could return cached response based on a stale read). Sticking with D1.

**Layer 2 — Semantic dedup via `tasks.idempotency_key`:**

- Caller sets `idempotency_key: "<source_kind>:<source_id>:<external_id>:<version>"` in the request body (e.g. `"notion:ws_abc:page_xyz:v3"`).
- **Caller is responsible for namespacing.** The unique index is `(org_id, idempotency_key)` only — no `source_kind` column. Two different Notion workspaces in the same org both using `"notion:<page_id>"` would collide.
- **Format validation (v1):** keys must match `^[a-z][a-z0-9_-]{0,31}:.{1,200}$` — a lowercase source-kind prefix (1-32 chars, starts with a letter), a colon, then up to 200 chars of namespace/id payload. Examples: `"notion:ws_abc:page_xyz:v3"`, `"hermes:t_abc123"`, `"mc:t_xyz"`. The Zod validator returns `400 idempotency.format` on mismatch. This catches the common footgun of passing a raw external id without a source prefix, which would silently share the namespace with every other caller that did the same.
- Partial unique index `(org_id, idempotency_key) WHERE deleted_at IS NULL AND idempotency_key IS NOT NULL` enforces uniqueness for active rows.
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

Cursors encode `(updated_at, id, org_id)` then **HMAC-signed** with `BETTER_AUTH_SECRET` and base64'd. The HMAC binds the cursor to the org that minted it — a caller can't decode the cursor and probe other orgs' data, and any tampering fails verification. Stable under inserts because the cursor encodes an ordering position, not an offset. `null` next_cursor means end of results.

`limit` defaults to 50; max 100. Larger requests get clamped silently.

---

## Sync model (event log + cursors)

The `events` table is an append-only ordered change log. Every mutating handler emits a row (or rows) before returning. Event kinds:

- `task.created`, `task.updated`, `task.status_changed`, `task.assigned`, `task.deleted`
- `project.created`, `project.updated`, `project.deleted`
- `agent.created`, `agent.updated`, `agent.deleted`, `agent.key_rotated`
- `connector.created`, `connector.updated`, `connector.deleted`, `connector.key_rotated`
- `comment.created`, `comment.deleted`
- `external_ref.added`, `external_ref.removed`

Consumers (Notion connector, hermes adapter, …) poll `GET /v1/events?since=<last_id>&kinds=<...>&limit=100` and store their cursor client-side. The endpoint is documented in §"Events" above. Server-side cursors (admin visibility into consumer lag) deferred to v1.1.

**"Has this row been synced by me?"** answered by `external_refs` presence:

```sql
SELECT 1 FROM external_refs
WHERE org_id = ? AND resource_type = 'task' AND resource_id = ?
  AND source_kind = ? AND source_id = ? AND deleted_at IS NULL;
```

`external_refs.presence == synced`. No separate per-row sync-state table needed.

### Event payload schemas

The `events.payload` JSON shape per `kind`. Stable contract — additive changes only on v1, breaking changes require a new event kind (`task.status_changed_v2`).

```typescript
// task.created — { task: { full task row } }
// task.updated — { changed: { field: [oldValue, newValue], ... } }
// task.status_changed — { from: <status>, to: <status>, reason?: string }
// task.assigned — { from: <agent_id|null>, to: <agent_id> }
// task.deleted — {}  (the task row itself is soft-deleted; lookup the row for body)
// project.created — { project: { full project row } }
// project.updated — { changed: { field: [oldValue, newValue], ... } }
// project.deleted — {}
// agent.created — { agent: { full agent row } }
// agent.updated — { changed: { field: [oldValue, newValue], ... } }
// agent.deleted — {}
// agent.key_rotated — { rotated_at: <integer ms> }   -- new key emitted to caller, not in event
// connector.created — { connector: { full connector row } }
// connector.updated — { changed: ... }
// connector.deleted — {}
// connector.key_rotated — { rotated_at: ... }
// comment.created — { comment: { full comment row } }
// comment.deleted — {}
// external_ref.added — { ref: { full external_ref row } }
// external_ref.removed — { ref_id: <string> }
```

Consumers reading the event log MUST handle "resource-missing" on follow-up fetch — a `task.created` event followed by a `task.deleted` event in the same poll batch means the row is gone when you fetch it. This is normal; events are immutable, resources are not.

---

## Observability

- Every request gets a `cf-request-id` (Cloudflare-assigned) propagated into structured logs.
- Hono logger middleware emits one JSON line per request: `{ ts, request_id, method, path, status, ms, org_id, principal }`.
- Errors logged with full stack to stderr; Workers Logpush ships to wherever (R2 / external) in prod.
- Per-route latency histograms via Workers Analytics Engine (v1.1).

No external APM in v1. Workers' built-in observability covers the basics.

**Logging hygiene (NEVER log):**

- Full bearer tokens (only the display prefix is OK)
- Request bodies on `/v1/auth/*` (passwords, OAuth tokens flow through)
- `apiKey.metadata` raw (contains org_id which is fine, but in case future plugins add secrets)
- OAuth provider client secrets, signing keys, Better-Auth secret

Hono's logger middleware is configured with a body-skipper for any path matching `/v1/auth/*` or `/v1/bootstrap`.

---

## Security & web

### CSRF + cookies

Better-auth issues session cookies with `SameSite=Lax` and `Secure` (production) by default. We additionally enforce:

- **All state-changing `/v1/*` endpoints reject `Content-Type: application/x-www-form-urlencoded`.** They accept only `application/json`. Form-encoded requests bypass JSON's CORS preflight; rejecting them collapses the classical CSRF attack surface.
- For browser clients (future custom UI), use the session cookie path; for non-browser clients use PATs (bearer header), which aren't sent automatically by browsers.

### CORS

Two modes:

- **SaaS production:** allowed origins from `CORS_ALLOWED_ORIGINS` env var (comma-separated). Credentials enabled. Strict allowlist; no wildcards.
- **OSS self-host:** defaults to NO origins until configured. The first thing a self-hoster does is set `CORS_ALLOWED_ORIGINS=https://my.notion-connector.example,…`.
- **Local dev:** `http://localhost:*` allowed via a dev-only middleware bypass when `DB_MODE=single` AND `NODE_ENV=development`.

CORS middleware is registered BEFORE the auth handler so preflights resolve cleanly without auth.

### Rate limiting (v1)

Cloudflare Workers' native rate-limit binding for coarse per-IP and per-key protection:

- Per-IP: 600 requests / minute on `/v1/*` (covers brute-force on auth).
- Per-key: 60 requests / minute on `/v1/tasks*` and `/v1/events*` for `agent` and `connector` keys (covers runaway polling). Configurable per org in v1.1.
- Exceeded → `429` with `Retry-After` header.

Better-auth's apiKey rate limiting (the `rateLimitEnabled` flags) is disabled — it's racy under Workers concurrency. Cloudflare's binding handles concurrent counting correctly.

### Token storage and rotation

- All tokens stored as bcrypt-of-sha256 (better-auth default; verified Workers-compatible).
- `apiKey.expiresAt` default: NULL (no expiry) for `agent` and `connector` keys; 90 days for `pat` (configurable at mint time).
- `POST /v1/agents/:id/rotate-key` mints a new key first, then disables the old key after a **5-minute grace window** (env-driven `KEY_ROTATION_GRACE_SECONDS`). Lets in-flight requests on the old key complete without hard failure.

---

## Environment variables

Required at startup:

| Var                          | Required | Default  | Notes                                                                  |
| ---------------------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`         | yes      | —        | 32+ random bytes; used for session signing + cursor HMAC               |
| `BETTER_AUTH_URL`            | yes      | —        | Public base URL (`https://api.example.com` or `http://localhost:8787`) |
| `DB_MODE`                    | no       | `single` | `single` or `split`                                                    |
| `CORS_ALLOWED_ORIGINS`       | no       | (empty)  | Comma-separated origins for browser clients                            |
| `MC_ADMIN_TOKEN`             | no¹      | —        | Required to call `/v1/bootstrap` on first run                          |
| `KEY_ROTATION_GRACE_SECONDS` | no       | `300`    | Old key valid for N seconds after rotate-key                           |
| `EVENTS_RETENTION_DAYS`      | no       | `365`    | Cron purges events older than this                                     |
| `IDEMPOTENCY_TTL_SECONDS`    | no       | `86400`  | Layer-1 idempotency cache TTL                                          |

OAuth providers (per-provider): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, etc. — configured as better-auth `socialProviders`. Omitted providers simply don't appear on the sign-in surface.

¹ Required on first deploy (before any user exists); can be unset after bootstrap completes.

A complete `.env.example` ships in the repo with every variable, sensible dev defaults, and inline comments.

---

## API response conventions

### Time format

Timestamps in responses are returned as **RFC 3339 strings** (`"2026-05-22T19:34:00.000Z"`), not integers. Internal storage stays as INTEGER ms epoch; serialization converts on the way out. This is unambiguous, human-readable, and parses with `new Date(...)` in every language. Clients that need ms-precision parse the string.

### Request IDs

Every response carries `X-Request-Id: <cf-request-id>` so callers can quote it in support tickets. The same ID appears in structured logs.

### API versioning

`/v1/` prefix is the v1 contract. Additive changes (new fields, new endpoints, new event kinds) ship to `/v1/` indefinitely. Breaking changes require `/v2/` with a stated deprecation timeline for `/v1/` (no shorter than 12 months). Event kinds use `kind_v2` naming for forward-compatible additions.

---

## Backups and operational concerns

### SaaS (D1)

- D1 PITR (Time Travel) covers 30 days on paid plan; no separate backup needed for the master DB.
- Pool DBs likewise. For a premium dedicated pool, customers can request weekly `wrangler d1 export` archives delivered to their own R2 bucket (v1.1 feature).

### Self-host (SQLite)

- Copy `.wrangler/state/v3/d1/` directory from the `/data` volume (see `docs/self-hosting.md`).
- `wrangler d1 export DB --output=backup-$(date +%F).sql` from a Cron-triggered Worker, or
- Documented in `docs/self-hosting.md` (separate doc, written alongside the v1 implementation).

### Cron-triggered tasks (Cloudflare Cron Triggers)

| Cron           | What                                              | When            |
| -------------- | ------------------------------------------------- | --------------- |
| `0 3 * * *`    | Purge `events` older than `EVENTS_RETENTION_DAYS` | Daily 03:00 UTC |
| `0 4 * * *`    | Purge `idempotency_keys` past `expires_at`        | Daily 04:00 UTC |
| `*/15 * * * *` | Purge expired `verification` rows (better-auth)   | Every 15min     |

For self-host, wrangler dev simulates cron triggers via `--test-scheduled`. Crons run on the same Workers schedule as prod.

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
      client.ts           # D1 client factory (drizzle-orm/d1)
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
      0001_better_auth_base.sql      # drizzle-kit output of better-auth tables
      0002_better_auth_additional.sql # additionalFields on organization + apiKey
      0003_tenant_pools.sql           # hand-written; our routing registry
    pool/
      0001_init.sql                   # hand-written; all pool schema
  scripts/
    bootstrap.ts          # first user + first org via better-auth admin API
    seed-dev.ts           # local-dev seed data
  test/
    helpers/
      auth.ts             # signUp(), createOrg(), mintAgentKey() helpers
    routes/
  wrangler.toml           # compatibility_flags = ["nodejs_compat"]
                          # required by better-auth on Workers (AsyncLocalStorage).
                          # multiple [[d1_databases]] entries for master + each pool.
  Dockerfile              # wrangler dev container for self-hosters (local SQLite-backed D1)
  .env.example            # documented env vars (see "Environment variables" section)
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
  LICENSE                 # MIT
  docs/
    self-hosting.md       # backup/restore, env vars, Docker run
    specs/
      2026-05-22-master-api-design.md   # this file
    plans/
```

### Local OSS Docker target

The OSS Docker image runs **`wrangler dev`** (not a separate Node server). This keeps
self-host and prod on identical code paths — the same Workers bundle runs everywhere.

Two clear personas:

- **OSS self-hoster:** `docker run mc-image` → wrangler dev + local SQLite-backed D1 persisted to `/data`.
- **Contributor / SaaS dev:** `wrangler dev` on the dev machine → workerd + local D1 + hot reload.

---

## What v1 ships

- ✅ Worker deployable to Cloudflare with master + 1 pool D1
- ✅ Self-host as a Docker image (wrangler dev + local SQLite-backed D1)
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

| Item                                       | Why deferred                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_links` (parent/child)                | Subtask graphs stay in agents' local kanbans per the design principle.                                                                                     |
| `task_runs`                                | Master tracks final outcome; agents track retries locally.                                                                                                 |
| Heartbeat endpoint                         | `tasks.updated_at` is a sufficient proxy for v1 cadences; middleware also bumps `agents.last_seen_at` / `connectors.last_seen_at` on every authed request. |
| SSE / WebSockets (`GET /v1/stream/events`) | Polling `GET /v1/events` at 10-30s is free and dead-simple to debug; add streaming when latency matters.                                                   |
| Server-side cursors                        | Client-side is sufficient until multi-instance consumers or admin lag visibility need it.                                                                  |
| Fine-grained scopes                        | Coarse roles cover v1; add scope strings when an integration genuinely needs less than `connector`.                                                        |
| User CRUD via API                          | Bootstrap script + direct DB v1; user-API arrives with the custom UI work.                                                                                 |
| Webhooks out                               | Pull (event log) is enough for v1.                                                                                                                         |
| Per-tenant D1 (sharded pools)              | Schema supports it via `tenant_pool_id`; ops setup waits for the first paying customer.                                                                    |
| Billing / metering / rate limits           | `orgs.plan` exists; enforcement waits for SaaS launch.                                                                                                     |
| Notion connector                           | Separate spec — `2026-MM-DD-notion-connector-design.md`.                                                                                                   |
| Hermes adapter                             | Separate spec — `2026-MM-DD-hermes-adapter-design.md`.                                                                                                     |

---

## Open questions for review

1. **Failure handling for spawn-style operations:** when an agent's `consecutive_failures` would hit a limit, who decides the action? In Hermes's local kanban the dispatcher auto-blocks. In the master, there's no dispatcher — only the agent itself reports. v1 leaves this to convention (agent calls PATCH status=blocked); we may add server-side detection v1.1.
2. **Migration of org between pools:** schema supports updating `organization.tenantPoolId`, but moving data between pools is non-trivial (cross-DB copy). The pool resolver's 60s isolate cache also means up to 60 seconds of writes go to the old pool after cutover. Out of scope v1; document as a planned-downtime ops procedure when first needed.
3. **Better-auth upgrade cadence:** when better-auth ships schema updates, the pipeline is (a) bump `package.json`, (b) `pnpm better-auth generate` regenerates `master.ts`, (c) `pnpm drizzle-kit generate` produces a diff SQL, (d) `wrangler d1 migrations apply` ships it. Coordinated upgrades across pool deployments stays a manual ops procedure for now.
4. **Bootstrap on first-deploy without `MC_ADMIN_TOKEN`:** Worker refuses to start. Should we instead allow the very first signup unconditionally (and disable the open-signup path after the first user exists)? Tradeoff: more friction during ops vs. brief signup-window vulnerability. v1 picks the strict path.
