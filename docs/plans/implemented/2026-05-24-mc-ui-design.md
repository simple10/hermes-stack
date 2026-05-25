# MissionControl UI — Design

**Status:** Draft for review
**Date:** 2026-05-24
**Scope:** v1 of the MissionControl operator + read-only-tasks UI, shipped as an SPA bound to the existing MC Worker.
**Sibling specs:**
- `services/mission-control/docs/specs/2026-05-22-master-api-design.md` (MC API — gets a small amendment described in §18)
- `docs/specs/2026-05-23-mission-control-plugin-design.md` (Hermes ↔ MC plugin — requires a URL convention update described in §6)

This spec covers the UI only. It also defines two API-side pre-work items the UI depends on: (a) extracting per-route Zod schemas into a shared `src/schemas/` module (§11), and (b) renaming the API mount prefix from `/v1/*` to `/api/v1/*` so the SPA and API share an origin (§5).

---

## 1. Goal

Give a MissionControl operator a single browser UI to:

1. **Sign up, verify email, sign in** (email/password + magic link + password reset).
2. **Manage their profile, sessions, and PATs** (mint, list, revoke).
3. **Create and switch between organizations**; manage members and invitations.
4. **Register and manage agents** (MC's machine principals for Hermes VMs, Claude sessions, OpenClaw runs); mint and rotate their keys.
5. **Register and manage connectors** (Notion, Linear, GitHub, custom); mint and rotate their keys.
6. **Manage projects** (create, edit, delete).
7. **Read tasks** — list with filters, detail with embedded comments / events / external refs. No task mutation in v1.
8. **Read the events log** for audit / debugging.

Operator mental model: *"I'm administering my MC org. I need to onboard agents, manage members, and observe what's happening to tasks — without ever touching curl. For creating and editing tasks themselves, I still use Notion (or another connector) per the master API spec."*

The UI closes the **operator gap** that currently forces users into curl for first-time setup (signup, org creation, mint-PAT, mint-agent-key). Tasks remain read-only because Notion stays the human-facing task surface per the master API spec — v1 does not duplicate that surface.

---

## 2. Non-goals (explicit)

- **Task creation, editing, status changes, or commenting from the UI.** Notion (or a future connector) owns those flows. The UI shows them read-only.
- **A kanban-style board.** A simple table covers read-only at the operator scope.
- **OAuth providers** (Google, GitHub login). Email/password + magic link only in v1.
- **MFA / 2FA.** better-auth supports it; we don't wire its UI in v1.
- **Mobile-quality responsive design.** Operator surface is desktop-first; mobile is best-effort, not a quality bar.
- **SSR / server-rendered pages.** SPA only, served via Workers Assets.
- **Self-host on non-Cloudflare runtimes.** "Self-host" here means self-hosted on Cloudflare. Future provider abstraction lives behind the `sendEmail` adapter (§9) but isn't a v1 deliverable.
- **OpenAPI / SDK generation.** Schema extraction (§11) sets it up structurally; doc generation is a separate later pass.
- **Optimistic UI updates.** v1 is `mutate → invalidate → refetch`. Simple and correct.

---

## 3. Decisions locked before this spec

These are confirmed and not re-litigated below:

| Decision | Locked-in value | Resolved via |
|---|---|---|
| Scope | Operator + read-only tasks | Prior session |
| Deploy shape | Same Worker, SPA in `services/mission-control/web/`, Workers Assets binding | Prior session |
| Auth surface | Email/password + magic link + password reset | Prior session |
| Component library | `better-auth-ui` for auth + settings + user-button; shadcn primitives for everything else | Prior session |
| React framework | React 18+, Vite, Tailwind v4, shadcn/ui | Prior session |
| Multi-org URL UX | Implicit active-org via `session.activeOrganizationId` + nav switcher; no org in URL paths | This session Q1 |
| Task view shape | Simple filterable table, cursor pagination | This session Q2 |
| Email provider intent | Cloudflare Email Service (transactional) — with implementation pre-flight check + adapter-clean fallback to MailChannels or Resend if CES doesn't fit; see §9 | This session Q3 |
| Routing library | TanStack Router (file-based, type-safe) | This session Q4 |
| API path migration | Hard cutover from `/v1/*` to `/api/v1/*`, no alias | This session §5 follow-up |
| Service-client URL convention | Env var = base up to but not including `/v1/`; client owns the version path and strips trailing `/` | This session §6 follow-up |
| Schema extraction depth | Requests + responses both as Zod; requests validated at runtime; responses NOT (skip overhead); export types for UI; structure for future OpenAPI gen | This session §11 question |
| Dev toolchain | Cloudflare's official `@cloudflare/vite-plugin` — single `pnpm dev` command, unified HMR for Worker + React | This session §13 follow-up |

---

## 4. Architecture

**One Worker, two surfaces.** The existing MC Worker continues to serve all `/api/v1/*` paths (Hono router with the MC routes + better-auth handler). The new SPA, built into `services/mission-control/web/`, is bound to the same Worker via Cloudflare's **Workers Assets** binding. The Cloudflare Vite plugin (`@cloudflare/vite-plugin`) runs Worker + Vite in one process during development and produces a single deployable artifact at build time.

```
   ┌─────────────────────────── Cloudflare Worker ───────────────────────────┐
   │                                                                          │
   │   ┌──── Hono router (src/index.ts) ─────────┐    ┌──── Workers ────┐    │
   │   │                                          │    │     Assets      │    │
   │   │  /api/v1/auth/*  → better-auth handler   │    │                 │    │
   │   │  /api/v1/*       → MC routes (existing)  │    │  web/dist/...   │    │
   │   │                                          │    │  index.html     │    │
   │   └──────────────────────────────────────────┘    │  assets/*.js    │    │
   │                                                    │  assets/*.css   │    │
   │   wrangler.jsonc: assets.run_worker_first =       │                 │    │
   │     ["/api/*"]  →  /api/* skips asset check,      │  SPA fallback:  │    │
   │     hits Worker directly. Everything else         │  unmatched →    │    │
   │     served from Assets; unmatched routes fall     │  index.html     │    │
   │     back to index.html for TanStack Router.       └─────────────────┘    │
   └──────────────────────────────────────────────────────────────────────────┘
                                       ▲
                                       │ same-origin: session cookies + API calls
                                       │
                                  Browser SPA
```

**Why same Worker, not a separate Pages project:**
- Same-origin → zero CORS plumbing. The `better-auth` session cookie set at `/api/v1/auth/sign-in/email` is automatically sent with every `/api/v1/...` fetch from the SPA. Browser never sees a PAT.
- One deploy artifact, one URL, one env var set.
- Workers Assets pricing is flat per request; we already pay per-request on the API.
- Self-host (CF) parity for free — no second service to deploy.

---

## 5. API path migration (pre-work)

The existing Worker mounts at `/v1/*` and `/v1/auth/*`. We rename to `/api/v1/*` and `/api/v1/auth/*` so the `/api/` prefix forms a clean boundary between Worker-owned and asset-served paths.

**Hard cutover, no alias.** No third-party consumers exist yet; only the in-tree Hermes plugin (`services/hermes/plugins/mission-control/`) is affected and is updated in the same release.

**Operator-facing release-notes obligation.** Deployed `HERMES_MC_URL` values must be updated (e.g., `https://mc.example.com` → `https://mc.example.com/api`) as part of the rollout. The release notes for this change call this out explicitly so self-hosters update env vars before redeploying the Hermes plugin.

**Affected files:**
- `services/mission-control/src/index.ts` — Hono mounts change from `/v1/*` to `/api/v1/*`.
- `services/mission-control/src/auth/config.ts` — `basePath: '/v1/auth'` → `'/api/v1/auth'`.
- `services/mission-control/test/**/*` — all ~469 tests that hit `/v1/...` paths get s/`\/v1\//`\/api\/v1\//`g.
- `services/hermes/plugins/mission-control/` — the plugin keeps appending `/v1/...` to its base URL; what changes is the env-var convention (§6). Deployed `HERMES_MC_URL` values gain an `/api` suffix in the combined-with-SPA deployment topology; the plugin source is otherwise untouched.
- `BETTER_AUTH_URL` env var — production value gets `/api` appended (e.g., `https://mc.example.com/api`); the better-auth `basePath` value is now `/api/v1/auth`.
- `services/mission-control/README.md` and the master API design spec (§18) — documentation update only.

---

## 6. Hermes plugin URL convention update

(Sibling-spec amendment; not strictly UI work but coupled to the API path migration above.)

The `HERMES_MC_URL` env var convention changes:

| Topology | Env var value | Plugin appends | Effective URL |
|---|---|---|---|
| Today (API at `/v1/*`) | `https://mc.example.com` | `/v1/agents` | `https://mc.example.com/v1/agents` |
| Combined SPA + API on one Worker (this work) | `https://mc.example.com/api` | `/v1/agents` | `https://mc.example.com/api/v1/agents` |
| Future split: API on its own subdomain (no `/api/` prefix needed because the whole subdomain is the API) | `https://api.example.com` | `/v1/agents` | `https://api.example.com/v1/agents` |

**Convention** (also captured as a stack-wide memory):
1. Env var = base URL **up to but NOT including** `/v1/`.
2. Plugin owns the `/v1/` segment because it is version-pinned in its own release.
3. Plugin strips trailing `/` from the env var on load so copy-pasted values with or without the slash both work.

This decouples deployment topology (combined SPA + API vs split subdomain) from plugin code. The same client binary works against `mc.example.com/api/v1/*` and `api.example.com/v1/*` with only an env-var change.

---

## 7. App shell & URL structure

**Router:** TanStack Router with **file-based routing**. The `@tanstack/router-plugin/vite` plugin generates `src/routeTree.gen.ts` from the file tree, yielding type-safe `Link`, `useNavigate`, `useSearch`.

**Route tree:**

```
/                              → redirect: signed-in → /tasks, anon → /sign-in
/sign-in                       → better-auth-ui <SignIn />
/sign-up                       → better-auth-ui <SignUp />
/forgot-password               → better-auth-ui <ForgotPassword />
/reset-password                → better-auth-ui <ResetPassword />   (?token=...)
/verify-email                  → handled by <SignIn /> flow + email template (?token=...)
/magic-link                    → handled by <SignIn /> flow + email template (?token=...)
/accept-invitation             → custom: calls authClient.organization.acceptInvitation()
/onboarding/create-org         → custom: single-input wizard, post-signup

_authed/                       (layout route — guards everything below)
  tasks                        → list (filters in URL search params)
  tasks/$taskId                → detail (comments, events, external_refs tabs)
  events                       → log viewer (kinds + since filters)
  projects                     → list + create dialog
  projects/$projectId          → edit
  agents                       → list + register dialog
  agents/$agentId              → detail (rotate-key, delete)
  connectors                   → list + register dialog
  connectors/$connectorId      → detail (rotate-key, delete)
  settings/                    (nested layout — sidebar nav within Settings)
    profile                    → better-auth-ui <AccountSettings />
    sessions                   → better-auth-ui <ActiveSessions />
    api-keys                   → custom: PATs (mint, list, revoke)
    organization               → custom: rename, leave, delete
    organization/members       → custom: list, change role, remove
    organization/invitations   → custom: list, send, cancel
```

**App shell** (the `_authed` layout):

- **Top bar:** logo and **org switcher** on the left, **user button** on the right. Org switcher lists orgs from `authClient.useListOrganizations()`; switching calls `authClient.organization.setActive()` and clears the entire TanStack Query cache (§10). User button is `<UserButton />` from better-auth-ui with menu links to Settings and Sign out.
- **Sidebar (left):** Tasks, Events, Projects, Agents, Connectors, divider, Settings. Collapsible.
- **Main:** route outlet.

**Auth guard:** the `_authed` layout's `beforeLoad` checks the session via `authClient`. If no session, throws `redirect({ to: '/sign-in', search: { redirect: location.pathname + location.search } })`. On successful sign-in, the better-auth-ui `redirectTo` callback reads `search.redirect` and bounces back. (Default fallback: `/tasks`.)

**SPA shell flash on unauth.** Because routing/auth-checking is client-side, an unauthenticated visitor briefly sees the SPA shell (`index.html` + JS bundle) before the auth guard redirects. This is accepted v1 behavior — no PII leaks, no protected data fetched, just an empty layout for a few hundred milliseconds. A loading skeleton inside `__root.tsx` smooths the visual.

**No org slug in URLs.** Active org is implicit via `session.activeOrganizationId`. If a user lands on a deep link to a resource not in their active org, the API returns 404 and the UI shows "Not found in current org. Try switching orgs." (Detecting whether the resource exists in another of the user's orgs is deferred — a 404 stays a 404 in v1.)

---

## 8. Page-by-page surface

Three buckets: **better-auth-ui-shipped** (drop-in via shadcn registry), **MC-built operator screens** (custom shadcn + better-auth client hooks), **read-only screens** (custom shadcn + API).

### Better-auth-ui-shipped

Installed via the shadcn CLI from three registries (per `https://better-auth-ui.com/docs/shadcn`):

```bash
pnpm dlx shadcn@latest add https://better-auth-ui.com/r/auth.json
pnpm dlx shadcn@latest add https://better-auth-ui.com/r/settings.json
pnpm dlx shadcn@latest add https://better-auth-ui.com/r/user-button.json
```

Source files land under `web/src/components/...` (exact path per `components.json`). We own these files — updates come from re-running the CLI and reviewing the diff. Prereqs (installed first): `better-auth`, `shadcn/ui` (init), `sonner`.

| Route / location | Component | Registry |
|---|---|---|
| `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password` | `<SignIn />`, `<SignUp />`, `<ForgotPassword />`, `<ResetPassword />` | auth.json |
| `/verify-email`, `/magic-link` | handled by `<SignIn />` flow + corresponding email templates | auth.json |
| `/settings/profile` | `<AccountSettings />` (combines profile / change-email / change-password / security / linked-accounts) | settings.json |
| `/settings/sessions` | `<ActiveSessions />` | settings.json |
| Top-bar | `<UserButton />` (avatar + menu) | user-button.json |

**Email templates shipped:** `EmailVerificationEmail`, `MagicLinkEmail`, `ResetPasswordEmail`, `PasswordChangedEmail`. Rendered server-side from better-auth hooks (§9).

**Provider:** the SPA root wraps with `<AuthProvider>` (config in §9). Exact prop names tracked from `better-auth-ui/docs/react`; the implementer pins a version of `better-auth-ui` in the package.json comment alongside the install commands and validates props against that version's docs.

### MC-built operator screens (custom, same pattern throughout)

All follow the shape **list view with table + register/create dialog**, **detail view with edit + danger zone**, built from shadcn primitives: `<Table>`, `<Dialog>`, `<DropdownMenu>`, `<Card>`, `<Input>`, `<Form>`, `<Badge>`, `<Button>`.

#### Organization screens (built atop `authClient.organization.*`)

- **Org switcher** in top nav — `authClient.useListOrganizations()` + `.setActive()`, query-cache wipe on switch (§10).
- `/onboarding/create-org` — name input → `authClient.organization.create({ name, slug })`.
- `/settings/organization` — rename (`.update()`), leave (`.removeMember(self)`), delete (`.delete()`).
- `/settings/organization/members` — table from `.useListMembers()`; role dropdown calls `.updateMemberRole()`; remove calls `.removeMember()`.
- `/settings/organization/invitations` — table from `.useListInvitations()`; invite form calls `.inviteMember()`; cancel calls `.cancelInvitation()`.
- `/accept-invitation?token=...` — calls `.acceptInvitation()` and redirects to `/tasks`.

#### API Keys (PATs) — `/settings/api-keys` (built atop `authClient.apiKey.*`)

- Table from `.list()`: name, prefix (e.g., `mcpat_xx…`), created, last used, expires, actions.
- **Create dialog** — fields: name, expiresIn (dropdown: 7d / 30d / 90d / never). Submit → `.create({ name, prefix: 'mcpat_', expiresIn })` → server returns the full `mcpat_...` exactly once → modal shows it with a copy-to-clipboard panel and a clear "this is the only time you'll see this" warning + a Done button that dismisses.
- **Revoke** → confirm dialog → `.delete({ keyId })`.
- The key string is never put into URL params, never logged to console, never persisted client-side beyond the modal lifetime.

#### Agents — `/agents` + `/agents/$agentId` (atop MC's `/api/v1/agents`)

- **List:** name, kind, last_seen_at (relative), created_at; "Register" button opens dialog.
- **Register dialog:** name, kind, description. Submit → `POST /api/v1/agents` → response includes `{ agent, key }` with the full `mcagt_...` — same one-shot key-reveal modal as PATs.
- **Detail:** edit name/description (PATCH), **Rotate key** action (modal: shows new `mcagt_...` once; warns that the old key remains valid for `KEY_ROTATION_GRACE_SECONDS` per the API spec), **Delete** action (handles `409 agent.has_active_tasks` by toasting with the blocking task IDs as inline `<Link>`s to `/tasks/$id`).

#### Connectors — `/connectors` + `/connectors/$connectorId`

Same shape as agents, against `/api/v1/connectors*`. Prefix: `mccnn_`. Permission gate: owner/admin only (member-role users see a "Read-only — owner/admin can create" state).

#### Projects — `/projects` + `/projects/$projectId`

- **List:** name, slug, description, task count (computed via `GET /api/v1/tasks?project_id=...&limit=1` and reading the `next_cursor` presence — exact behavior validated at implementation; if expensive (one extra request per project), drop the count badge or batch). Caveat: project name on the tasks list is resolved from a cached projects-list query — if an org has more projects than fit on the first page (default 50), some tasks may briefly show project id instead of name. Acceptable v1 trade-off; preloading all projects up front is the obvious next step if it bites.
- **Create dialog:** name, slug (auto-generated, editable), description.
- **Detail:** edit name/description/slug (PATCH), delete (soft).

### Read-only screens

#### `/tasks` (list)

- **Filter bar (top):** `project_id` (combobox from `/api/v1/projects`), `agent_id` (combobox from `/api/v1/agents`), `status` (multi-select), `updated_since` (date picker). Filters serialize to URL search params; TanStack Router validates them with a Zod search schema (imported from `@mc/schemas/tasks`).
- **Table columns:** title (links to detail), project name (resolved from id via cached projects query), agent name (resolved similarly; `—` if null), status (colored `<Badge>`), priority, updated_at (relative, with absolute on hover).
- **Pagination:** cursor-based, "Load more" button at bottom appending the next page. No infinite scroll (explicit is clearer for an operator surface).
- **Empty state:** "No tasks match these filters." with a "Clear filters" button.

#### `/tasks/$taskId` (detail)

- **Header:** title, status badge, project link, agent link, created/updated/started/completed timestamps.
- **Body:** markdown rendered (`react-markdown` with a conservative allowlist — no raw HTML, no embedded scripts). If the API returns plain text, it renders identically.
- **Three tabs:**
  1. **Comments** — chronological list from `GET /api/v1/tasks/:id/comments`, cursor-paginated. Each comment shows author_type + author_id + body + relative timestamp.
  2. **Events** — kind, actor, timestamp, expandable JSON payload. Sourced from the detail response's embedded `events` array (latest 20 per the API spec); a "View all events" link goes to `/events?resource_type=task&resource_id=...` (if the events endpoint supports those filters — the master API spec says `kinds` is comma-separated `resource_type`; per-resource filtering may need to be a v1 API enhancement — flagged in §18).
  3. **External refs** — table: source_kind, source_id, external_id, external_url (rendered as a link icon).
- **No edit affordances anywhere.** No "post comment" form. No status-change buttons. Deliberate per scope.

#### `/events` (log viewer)

- **Access:** human-role only (owner / admin / member); connector keys also allowed by the API. **Agent-role principals are excluded from `/api/v1/events` by the master API spec** — they would not see this screen anyway because they don't have a session, but the UI's sidebar omits the Events link when the active principal is agent-role (defensive even though agents aren't expected to use the UI).
- **Filter bar:** `kinds` (multi-select of resource_types), `since` (date or "all time" — translates to `since=0`).
- **Virtualized list** (via `@tanstack/react-virtual`) — events are long-tail and rich; a table-row-per-event would chew memory. Each row: kind, resource (clickable link to that resource's detail), actor, timestamp, expandable payload (JSON pretty-print on click via `react-json-view-lite` or similar — implementer's call on the lib).
- **Pagination:** cursor-based "Load more"; `refetchInterval: 30000` for periodic auto-refresh (only the events view does this).

#### `/onboarding/create-org` (one-shot wizard)

- Single form: org name (slug auto-derived). Submit → `authClient.organization.create()` → set as active → query-cache wipe → redirect to `/tasks` with a one-time toast: "Welcome! Next step: register an agent at /agents."

---

## 9. Auth & onboarding flow

### End-to-end happy path (new operator)

```
1.  Land on app URL → SPA renders → _authed guard: no session → redirect /sign-in (which has a "Sign up" link for new users).
2.  Sign-up via <SignUp /> (email + password OR magic-link).
    → POST /api/v1/auth/sign-up/email
    → better-auth creates user → fires sendVerificationEmail hook → Cloudflare Email Send.
3.  "Check your email" screen (better-auth-ui handles).
4.  User clicks verify link in email → GET /api/v1/auth/verify-email?token=… (the link itself is the verification request — better-auth handles it server-side and issues the session cookie). UI route `/verify-email` exists only as a landing destination if the user opens the SPA after verification or if the flow surfaces a UI prompt.
5.  Auth guard sees session but no activeOrganizationId → redirect /onboarding/create-org.
6.  Operator enters org name → authClient.organization.create({ name, slug }).
    → POST /api/v1/auth/organization/create (sets activeOrganizationId on session).
    → Clear query cache (queryClient.clear()) → redirect /tasks.
7.  Empty /tasks. Toast: "Welcome! Next step: register an agent."
8.  /agents → "Register agent" dialog → submit.
    → POST /api/v1/agents → response { agent, key: 'mcagt_…' }.
    → One-shot reveal modal: copy + "this is the only time" warning + Done.
9.  Operator pastes key into Hermes config (HERMES_MC_AGENT_KEY) + sets HERMES_MC_URL.
    → Hermes plugin authenticates and joins MC's events stream.
10. Returning visits: session cookie → straight to /tasks.
```

Steps 2–4 and 8–9 are the operator-pain points the existing curl-only flow doesn't solve. Steps 5–6 are the only bespoke onboarding logic we own — the rest is better-auth-ui drop-in.

### First-run / bootstrap (reconciling with the master API spec)

The master API spec (§"Bootstrap") gates the very first user creation behind `POST /v1/bootstrap` + `MC_ADMIN_TOKEN` header. This UI does **not** expose a bootstrap form — bootstrap stays an operator-side CLI / curl step, identical to today's behavior.

**Required master-spec amendment (this work depends on it).** Because this UI enables `emailAndPassword.requireEmailVerification: true`, the bootstrap endpoint must mark the user it creates as **already email-verified** — otherwise the operator finishes `mc-bootstrap`, receives a PAT, but cannot sign into the UI with email/password (better-auth blocks unverified accounts when the flag is on). The fix lives in the `/v1/bootstrap` handler: when it calls better-auth's server-side user creation, it sets `emailVerified: true` (the operator is presumed to control the email address they typed — they hold `MC_ADMIN_TOKEN`). Tracked in §18 as a hard prerequisite, not a flag-only inconsistency.

- **Self-host:** operator runs the documented `mc-bootstrap` script (or equivalent curl) once before opening the UI. That step creates the first user (pre-verified) + first org + returns a PAT. The operator then signs into the UI with the email/password they set during bootstrap. Better-auth's open-signup flow is also enabled, but on self-host access is typically gated by domain / network controls.
- **SaaS:** open-signup is the intended flow from day one; bootstrap is not needed. New signups go through the normal verification email.

If a user reaches the UI before any account exists on a self-host (because the operator skipped bootstrap) they will see the normal `/sign-up` screen and a verification email flow.

**Spec dependency:** the bootstrap-pre-verified-user change to the master spec MUST land before the UI's `requireEmailVerification: true` is enabled in production.

### Auth client (one file)

```ts
// web/src/lib/auth-client.ts
import { createAuthClient } from 'better-auth/react';
import { organizationClient, apiKeyClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: '/api/v1/auth',   // same-origin; cookies flow automatically
  plugins: [organizationClient(), apiKeyClient()],
});

export const { useSession, useListOrganizations, signIn, signUp, signOut } = authClient;
```

Same-origin means no `credentials: 'include'` plumbing — the session cookie better-auth issues at `/api/v1/auth/sign-in/email` is sent on every subsequent `/api/v1/...` request automatically.

### Auth provider (one wrap at app root)

The provider component name and prop surface comes from the installed version of `better-auth-ui` — historically it has shipped as `<AuthProvider>` and `<AuthUIProvider>` in different versions. **The implementer:**

1. Installs the three shadcn registries (`auth.json`, `settings.json`, `user-button.json`), pins the resulting version of `better-auth-ui` (the source files that landed in `web/src/components/...`).
2. Inspects the installed provider component to confirm its name and required props.
3. Wraps the SPA root accordingly. Expected shape (validate at install time):

```tsx
// web/src/main.tsx (shape — exact name + props per installed version)
<AuthUIProvider              {/* OR <AuthProvider /> per the installed version */}
  authClient={authClient}
  navigate={(path) => router.navigate({ to: path })}
  replace={(path) => router.navigate({ to: path, replace: true })}
  Link={Link}                {/* TanStack Router's Link — may be required */}
  redirectTo="/tasks"
>
  <RouterProvider router={router} />
</AuthUIProvider>
```

If the prop surface differs from the above, adjust at implementation time; this is a known small-uncertainty area documented as such.

### Server-side email (single adapter)

**Intent:** use **Cloudflare Email Service** (the newer outbound-capable product that supersedes the recipient-restricted Email Routing `send_email` binding). All email-sending code lives in **exactly one file** — `services/mission-control/src/auth/email.ts` — so a future provider swap is a one-file edit.

**Implementation pre-flight check (gate before writing the integration):**
1. Verify that Cloudflare Email Service exposes an outbound API that can send to **arbitrary unverified recipients** (required for new-user sign-up verification). If yes, use it.
2. If CES does not fit (e.g., still requires per-recipient verification, or the API is not GA at implementation time), fall back in this order:
   - **MailChannels via fetch** (CF Workers-native, free for Workers, supports arbitrary recipients, well-trodden path).
   - **Resend** (HTTPS API, generous free tier, trivial Workers integration).
3. The choice is made once at install time and recorded in `web/README.md` / the service README; the `sendEmail` adapter shape stays the same regardless.

**Adapter shape (provider-agnostic):**

```ts
// services/mission-control/src/auth/email.ts
import { render } from '@react-email/render';
// Email template components — sourced per implementer's discovery: better-auth-ui's
// shadcn registries may ship them; if not, the implementer writes minimal React
// Email templates inline in services/mission-control/src/auth/templates/*.tsx.
// Either way the import points at the local source files we own.
import {
  EmailVerificationEmailTpl,
  ResetPasswordEmailTpl,
  MagicLinkEmailTpl,
  PasswordChangedEmailTpl,
} from './templates';

export type SendEmailArgs = { to: string; subject: string; html: string; text: string };

// Provider implementation lives ONLY here. Caller code never sees CES / MailChannels / Resend.
export async function sendEmail(env: Env, args: SendEmailArgs): Promise<void> {
  // Concrete provider call inserted here per the pre-flight check above.
  // Example shape (CES, pending API verification at implementation time):
  //   await env.EMAIL.send(new EmailMessage(env.EMAIL_FROM, args.to, mimeBody));
  // OR (MailChannels via fetch):
  //   await fetch('https://api.mailchannels.net/tx/v1/send', { method: 'POST', body: JSON.stringify({...}) });
  // OR (Resend):
  //   await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }, body: JSON.stringify({...}) });
  throw new Error('TODO: implement per pre-flight choice');
}

// Each template-render helper also lives here so callers stay one-liners.
// All helpers are named with the `Email` suffix to avoid collisions with the
// better-auth hook names that consume them.
export async function deliverVerificationEmail(env: Env, params: { user: { email: string; name?: string }; url: string }) {
  const html = await render(EmailVerificationEmailTpl({ url: params.url, userName: params.user.name ?? params.user.email }));
  await sendEmail(env, { to: params.user.email, subject: 'Verify your MC email', html, text: params.url });
}
// ... similarly: deliverResetPasswordEmail, deliverMagicLinkEmail, deliverPasswordChangedEmail
```

Wired into the better-auth config:

```ts
// services/mission-control/src/auth/config.ts (additions; existing config preserved)
import {
  deliverVerificationEmail,
  deliverResetPasswordEmail,
  deliverMagicLinkEmail,
} from './email';
import { magicLink } from 'better-auth/plugins';

emailAndPassword: {
  enabled: true,
  requireEmailVerification: true,
  sendResetPassword: (args) => deliverResetPasswordEmail(env, args),
},
emailVerification: {
  sendVerificationEmail: (args) => deliverVerificationEmail(env, args),
  sendOnSignUp: true,
},
plugins: [
  organization({ /* existing */ }),
  apiKey({ /* existing */ }),
  magicLink({
    sendMagicLink: (args) => deliverMagicLinkEmail(env, args),
  }),
],
```

(Helpers renamed from `sendX` to `deliverX` so the local function name never collides with a better-auth hook of the same name — avoids self-referential `sendVerificationEmail: (args) => sendVerificationEmail(env, args)` shadowing pitfalls.)

**New env vars / bindings (provider-dependent — final set determined at implementation pre-flight):**

| Var / binding | Required | Notes |
|---|---|---|
| `EMAIL_FROM` | yes | `no-reply@mc.example.com` — the From address used by `sendEmail` |
| `EMAIL` (binding) | if CES is chosen | Cloudflare Email Service binding in `wrangler.jsonc` |
| `RESEND_API_KEY` | if Resend is chosen | secret bound via `wrangler secret put` |
| (MailChannels needs no key — DKIM-domain setup only) | — | DNS records documented in `services/mission-control/README.md` per chosen provider |

---

## 10. Data flow (TanStack Query)

### HTTP client (one file)

```ts
// web/src/lib/api.ts
// (Concrete response/query types imported from @mc/schemas/* per resource — elided.)

export class ApiError extends Error {
  constructor(public status: number, public code: string, public details?: unknown) {
    super(`${status} ${code}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.code ?? 'unknown', body?.error?.details);
  }
  return res.json();
}

export const api = {
  tasks:        { list, get, comments },
  agents:       { list, get, create, patch, rotateKey, delete: del },
  connectors:   { list, get, create, patch, rotateKey, delete: del },
  projects:     { list, get, create, patch, delete: del },
  events:       { list },
  externalRefs: { list },
};
```

Same-origin → session cookie automatic. No SDK generation in v1.

### Query keys

```ts
['tasks', filters]
['tasks', taskId]
['tasks', taskId, 'comments']
['agents']
['agents', agentId]
['connectors']
['connectors', connectorId]
['projects']
['projects', projectId]
['events', { kinds, since }]
```

Org id is **not** in keys — the session cookie carries it and we wipe the whole cache on org switch (below), so org-scoping is implicit.

### Org switch = full cache wipe (with session refetch)

```ts
async function switchOrg(orgId: string) {
  await authClient.organization.setActive({ organizationId: orgId });
  // Refetch the session so any client-cached session data reflects the new
  // activeOrganizationId before subsequent queries fire. Prevents the race
  // where useSession() returns the stale active-org id between setActive's
  // resolution and the cookie/cache update.
  await authClient.getSession({ query: { disableCookieCache: true } });
  queryClient.clear();
  router.invalidate();
}
```

Cheap, correct, no risk of a slipped query returning prior-org data. The extra session round-trip is only on org switches (rare for most operators).

### Pagination

`useInfiniteQuery` with `pageParam = previous next_cursor`. "Load more" button calls `fetchNextPage()`. No infinite scroll.

```ts
useInfiniteQuery({
  queryKey: ['tasks', filters],
  queryFn: ({ pageParam }) => api.tasks.list({ ...filters, cursor: pageParam }),
  initialPageParam: undefined,
  getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
});
```

### Mutations

Pattern: pessimistic — `mutate → invalidate → refetch`. No optimistic updates in v1.

```ts
const mutation = useMutation({
  mutationFn: api.agents.delete,
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
});
```

### Errors

Two surfaces:

1. **Toast** (`sonner`): mutation feedback — success and failure both.
2. **Inline `<ErrorBoundary>` fallback** for query errors that block a screen.

`web/src/lib/error-messages.ts` exports a single `messageFor(error: ApiError): string` switch over `error.code`. Default: `"Something went wrong. (request_id: …)"`. Specific cases worth calling out:

- `409 agent.has_active_tasks` → toast lists blocking task IDs as inline `<Link>`s to `/tasks/$id` (API returns them in `details.task_ids`).
- `401 auth.invalid` → mid-session expiry → router redirect to `/sign-in?redirect=<current>`.
- `409 task.invalid_transition` → toast (won't actually happen in v1 since UI doesn't mutate tasks, but the handler exists for consistency).
- `503 pool.binding_missing` → full-page "Service unavailable, try again shortly". Transient — Retry button.

### Not in v1

- No persistent query cache (no IndexedDB / localStorage).
- No SSE / streaming. Events view polls every 30s; everything else relies on post-mutation invalidation.
- No SSR. SPA only.
- No optimistic updates.

---

## 11. API schema extraction (pre-work)

**Goal:** the UI imports request and response types directly from the API's schema source. Future self-generating docs (separate later pass) derive OpenAPI from the same Zod.

**Status today:**
- Zod is used per-route, locally scoped (e.g., `const createBody = z.object({...})` inside `src/routes/tasks.ts`).
- No central `src/schemas/` directory — the master API spec mentioned one but it never materialized.
- Requests + query params have Zod; **response shapes are implicit** (DB row → manual `{ task: serialized }` shaping).
- Nothing is exported.

**New module layout:**

```
services/mission-control/src/schemas/
  common.ts          # id slug brands ('t_...', 'agt_...'), error envelope,
                     # pagination response wrapper, timestamp serializers,
                     # status enums, role enums, soft-delete fields
  agents.ts          # AgentCreateBody, AgentPatchBody, AgentListQuery,
                     # Agent (response), AgentListResponse, AgentCreateResponse
  connectors.ts      # mirrors agents
  projects.ts        # ProjectCreateBody, ProjectPatchBody, ProjectListQuery, Project, ...
  tasks.ts           # TaskCreateBody, TaskPatchBody, TaskListQuery, Task,
                     # TaskListResponse, TaskDetailResponse (includes embedded
                     # comments + events + external_refs latest-20)
  comments.ts        # CommentCreateBody, Comment, CommentListResponse
  events.ts          # EventListQuery, Event, EventListResponse
  external-refs.ts   # ExternalRefCreateBody, ExternalRef, ExternalRefListQuery,
                     # ExternalRefListResponse
  bootstrap.ts       # BootstrapBody, BootstrapResponse
  me.ts              # MeResponse
```

Each file exports **both** the runtime Zod schema and the inferred TS type. Example:

```ts
// src/schemas/tasks.ts
import { z } from 'zod';
import { IdSlug, IsoTimestamp, TaskStatus } from './common';

export const Task = z.object({
  id:           IdSlug('t_'),
  org_id:       IdSlug('org_'),
  project_id:   IdSlug('prj_'),
  agent_id:     IdSlug('agt_').nullable(),
  title:        z.string(),
  body:         z.string().nullable(),
  status:       TaskStatus,
  priority:     z.number().int(),
  metadata:     z.record(z.unknown()).nullable(),
  created_at:   IsoTimestamp,
  updated_at:   IsoTimestamp,
  started_at:   IsoTimestamp.nullable(),
  completed_at: IsoTimestamp.nullable(),
});
export type Task = z.infer<typeof Task>;
```

**Behavior:**

- **Requests** validated at runtime (no behavior change from today — same Zod `parse()` in handlers, just `import { TaskCreateBody } from '../schemas/tasks'` instead of defining inline).
- **Responses NOT validated at runtime** in production (skip overhead). Schemas exist for type inference + future doc-gen.
- **Optional dev-mode response validation** — a `validateResponses()` middleware enabled when `NODE_ENV !== 'production'` that calls `.safeParse()` on outgoing bodies and logs (does not throw) on mismatch. Catches drift during local dev + tests without prod cost. **Implementer's call** whether to ship in v1.

**UI consumption** via a tsconfig path alias:

```jsonc
// services/mission-control/web/tsconfig.json
{
  "compilerOptions": {
    "paths": { "@mc/schemas/*": ["../src/schemas/*"] }
  }
}
```

```ts
// web/src/lib/api.ts
import { type Task, type TaskListQuery, type TaskListResponse } from '@mc/schemas/tasks';
```

Vite resolves the path via `vite-tsconfig-paths`. No build coupling — the UI references API source files directly. Both sides type-check against the same Zod.

**Migration:** touch all 10 route files in `src/routes/*.ts` to import schemas instead of defining inline. Mechanical change; all 469 existing tests should continue to pass — behavior unchanged.

**Schema reconciliation requirement.** The Task / Agent / Connector / Project / etc. shapes shown above are illustrative — the implementer must **read each handler's actual response shape** (look at the `c.json(...)` call sites in `src/routes/*.ts`) and write the Zod to match what the API truly returns today. The 469 tests do not validate response shape (today), so they will stay green even if these schemas drift from reality. To prevent silent drift, the implementer enables the dev-mode `validateResponses()` middleware (`NODE_ENV !== 'production'`) during schema extraction and fixes any `.safeParse()` failures it flags.

**Server-only import constraint (critical for SPA bundle).** Files under `src/schemas/*` MUST import only from `zod`. They MUST NOT import:
- `drizzle-orm` (any path)
- `better-auth` (or any plugin)
- `../db/*`, `../auth/*`, `../routes/*`
- `cloudflare:*`, `node:*`
- The ambient `Env` / `D1Database` types are tolerable (they're erased at runtime), but as a discipline, schemas don't reference Worker-runtime types either.

**Two-layer enforcement** (one direct, one transitive):

1. **Direct-import lint** (ESLint `no-restricted-imports`) catches what's written in `src/schemas/*` files themselves. Added to `services/mission-control/eslint.config.js`:

```js
{
  files: ['src/schemas/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['drizzle-orm', 'drizzle-orm/*'], message: 'schemas/* must be browser-safe; no drizzle.' },
        { group: ['better-auth', 'better-auth/*'], message: 'schemas/* must be browser-safe; no better-auth.' },
        { group: ['cloudflare:*'], message: 'schemas/* must be browser-safe; no Worker bindings.' },
        { group: ['node:*'], message: 'schemas/* must be browser-safe; no Node built-ins.' },
        { group: ['../db/*', '../auth/*', '../routes/*'], message: 'schemas/* must not depend on server modules.' },
      ],
    }],
  },
},
```

2. **Transitive-import enforcement** via `dependency-cruiser` (or `eslint-plugin-import`'s `no-restricted-paths`) in CI — catches the case where `schemas/common.ts` imports a helper that *itself* imports drizzle. Configured to fail CI if any file under `src/schemas/**` has a transitive runtime dependency on `drizzle-orm`, `better-auth`, etc. Implementer chooses the tool; the goal is "the lint rule is not the only line of defense."

A complementary check: `pnpm build` produces `dist/client/` (SPA) — a CI step measures the bundle size and fails if it exceeds a budget (e.g., 500 KB gzipped baseline; alert at +20%). Catches accidental balloon from any source.

**TypeScript layout for cross-tree imports** (single-package, not a workspace split):

`web/tsconfig.json` uses path mapping, NOT TypeScript project references (`composite: true` would conflict with the existing service-root `tsconfig.json`'s `noEmit: true` + `allowImportingTsExtensions: true`). The web tsconfig sets `baseUrl: '..'` and includes the parent's schemas via `include`:

```jsonc
// services/mission-control/web/tsconfig.json (shape)
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "baseUrl": "..",
    "paths": { "@mc/schemas/*": ["src/schemas/*"] },
    "rootDir": ".."
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "../src/schemas/**/*.ts"]
}
```

The implementer validates the include/baseUrl shape against the first `tsc --noEmit` run and adjusts. No `references`, no `composite`.

**Future doc gen** (out of scope this session): `zod-to-openapi` (or similar) walks `src/schemas/` + a route manifest to emit `/api/v1/openapi.json` + a docs UI. The schema layout is structured so this is purely additive.

---

## 12. Styling & theming

- **Tailwind v4 + shadcn/ui** — `pnpm dlx shadcn@latest init` drops `web/components.json`, `web/src/index.css` with the `@theme` block, and `web/src/lib/utils.ts` (`cn()` helper).
- **better-auth-ui inherits shadcn's tokens** automatically — its components land via the same shadcn CLI and read the same CSS variables. Auth screens look like the rest of the app for free.
- **Single shared layout primitives** at `web/src/components/ui/...` (shadcn-generated). Added on demand.
- **Theme provider** at the app root toggles `class="dark"` on `<html>`. Persisted to `localStorage`. Three modes: `light` / `dark` / `system`. Toggle lives in the `<UserButton />` dropdown.
- **No custom design tokens v1.** Default shadcn neutral palette. A brand color can override `--primary` in `index.css` later.
- **No animation library** beyond `tailwindcss-animate` (shipped with shadcn). Page transitions are instant.
- **Desktop-first.** Sidebar collapses to a sheet on narrow viewports; mobile is best-effort.

---

## 13. Deploy + Workers Assets wiring

### Directory layout (explicit)

```
services/mission-control/
  wrangler.jsonc            # Worker config; main: "./src/index.ts" (existing)
  vite.config.ts            # NEW — Vite config at the service root; root: './web'
  package.json              # existing; gains web deps + scripts
  src/                      # existing Worker code (unchanged location)
  web/                      # NEW — SPA root
    index.html              # Vite's index entry (root = ./web)
    src/                    # SPA source
      main.tsx              # SPA bootstrap
      ...
    dist/                   # build output (gitignored)
```

**`pnpm dev`, `pnpm build`, `pnpm exec wrangler deploy` are all run from `services/mission-control/`.** The Cloudflare Vite plugin auto-discovers `wrangler.jsonc` in the same directory; Vite's `root: './web'` makes `web/index.html` the SPA entry.

**Existing Worker test setup is untouched.** The current `vitest.config.ts` at the service root drives the 469-test suite via `@cloudflare/vitest-pool-workers` (`cloudflarePool`); that file stays exactly as it is and `pnpm test` continues to run the existing API test suite unchanged. Vite (as a build tool via `@cloudflare/vite-plugin`) and Vitest (as a test runner via `cloudflarePool`) coexist — they share Vite's transformer but have separate config files and separate package.json scripts. The web suite gets its own `web/vitest.config.ts` for component tests (happy-dom + RTL) and runs via `pnpm --filter ./web test` or a new `pnpm test:web` root script. The two test suites never share a vitest invocation.

### `wrangler.jsonc` additions

```jsonc
{
  // existing main, compatibility_date, d1_databases, vars, etc.
  "assets": {
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  }
  // Email binding/secret declared here per the chosen email provider (§9 pre-flight).
}
```

`run_worker_first: ["/api/*"]` forces every `/api/*` request into the Worker (skipping the asset-binding check entirely); everything else falls through to the SPA. The Vite plugin auto-populates `assets.directory` and `assets.binding` at build time.

**Wrangler version requirement.** The array form of `run_worker_first` (`["/api/*"]`) is newer than the boolean form. The implementer verifies the globally installed wrangler version supports the array form before relying on it; if it doesn't, two fallbacks:
1. Upgrade the global wrangler to a version that supports it (preferred — modern wrangler is cheap to install).
2. Use `run_worker_first: true` (boolean — routes EVERYTHING through the Worker first) and re-add the Hono catch-all `app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))` to fall back to the asset binding for non-API paths.

The tested wrangler version is pinned in `services/mission-control/README.md` under "Operating versions."

### `vite.config.ts`

```ts
// services/mission-control/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tsconfigPaths from 'vite-tsconfig-paths';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';

export default defineConfig({
  root: './web',
  plugins: [
    TanStackRouterVite({ routesDirectory: 'web/src/routes', generatedRouteTree: 'web/src/routeTree.gen.ts' }),
    react(),
    cloudflare(),
    tsconfigPaths(),
  ],
});
```

(Plugin ordering matters: `react()` must precede `cloudflare()` per the CF + React tutorial. The implementer verifies this is still the case for the pinned plugin version.)

### Hono fallthrough — removed

Previous drafts had `app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))`. With `run_worker_first` the Worker only sees `/api/*` requests; asset routing happens before the Worker is invoked. Drop the line.

### Dev workflow

**Single command, single process, single port:**

```
pnpm dev     # = vite (runs the Worker in-process via @cloudflare/vite-plugin)
```

Vite serves the SPA at `http://localhost:5173` with the Worker handled in-process by `@cloudflare/vite-plugin` + miniflare. HMR for both React and Worker code; component state preserved across Worker edits.

### Build + deploy

```
pnpm build                  # → dist/client/ (SPA) + dist/<worker>/ (Worker bundle + generated wrangler.json)
pnpm exec wrangler deploy   # uses generated dist/<worker>/wrangler.json
```

One build pass, one deploy.

### Install

Dev deps:

```
pnpm add -D @cloudflare/vite-plugin vite @vitejs/plugin-react vite-tsconfig-paths \
            @tanstack/router-plugin tailwindcss @tailwindcss/vite
```

Runtime deps (the web bundle):

```
pnpm add react react-dom @tanstack/react-router @tanstack/react-query \
         @tanstack/react-virtual better-auth sonner react-markdown zod
```

(`zod` is in the runtime deps because the SPA uses it at runtime — TanStack Router's search-param validation calls `.parse()` against schemas imported from `@mc/schemas/*`.)

(Wrangler stays globally installed per the `cloudflare-project-conventions` memory — not added as a dev dep, contrary to the CF tutorial's instructions. Tradeoff: a globally installed wrangler version may drift from the version the Vite plugin generated config for. Mitigation: the implementer documents the wrangler version range tested in `services/mission-control/README.md` and bumps the global install in lockstep when upgrading the plugin.)

### Type generation

Continue using `wrangler types` to regenerate `worker-configuration.d.ts`. Ignore the tutorial's `@cloudflare/workers-types` mention — that package is deprecated. `wrangler types` picks up the auto-injected `ASSETS` Fetcher binding plus the email-provider binding/secret added per §9 pre-flight.

---

## 14. Testing strategy

### Frameworks

- **Vitest** + **@testing-library/react** + **@testing-library/jest-dom** for unit + component tests.
- **happy-dom** as the test environment.
- **MSW (Mock Service Worker)** to intercept `fetch` in tests — UI tests run without booting the Worker.
- **Playwright** for a thin E2E layer — runs against `pnpm dev` (real Worker, miniflare D1).

### Coverage targets

- Every custom MC screen (agents, connectors, projects, tasks list + detail, events): renders correctly with seed data, fires the right API call on mutation, handles 4xx/5xx error paths.
- App shell: auth-guard redirects, org switcher wipes cache, theme toggle persists.
- API client (`web/src/lib/api.ts`): error envelope parsing, query-string building.
- Hooks (`useSession`, `useListOrganizations`, custom mutation wrappers): mocked `authClient`.

### Playwright happy-path scenarios (v1)

1. Sign up → verify email (token captured from miniflare email mock) → create org → register agent → see key reveal modal.
2. Sign in → view tasks list (seeded) → open detail → view comments tab.
3. Switch org → tasks list updates (cache wipe).

### Not tested in v1

- better-auth-ui shipped components (tested upstream; we don't own them).
- Visual regression / screenshot diffing.
- Cross-browser matrix (Chromium-only Playwright).

### Coverage gate

Every custom screen ≥ 70% line coverage. Lower than the API's 80% because UI tests are inherently chunkier per assertion; the E2E layer compensates.

### CI

- `pnpm test` (existing API tests, unchanged).
- `pnpm --filter ./web test` (component + unit).
- `pnpm --filter ./web build` (catches both Vite and Worker bundle errors).
- `pnpm --filter ./web e2e` (Playwright, separate job because it's slower).

---

## 15. Repo layout

```
services/mission-control/
  src/                              # existing API code (with §5 mount rename + §11 schema extraction)
    index.ts                        # Hono mounts /api/v1/* and /api/v1/auth/*
    auth/
      config.ts                     # basePath: '/api/v1/auth'; sendVerificationEmail wired
      email.ts                      # NEW — single email adapter (Cloudflare Email Send)
      middleware.ts                 # unchanged
      roles.ts                      # unchanged
    routes/                         # all routes import from ../schemas/*
    schemas/                        # NEW — extracted Zod schemas (§11)
      common.ts
      tasks.ts
      agents.ts
      connectors.ts
      projects.ts
      comments.ts
      events.ts
      external-refs.ts
      bootstrap.ts
      me.ts
    db/                             # unchanged
  web/                              # NEW — the SPA
    index.html
    vite.config.ts
    tsconfig.json                   # paths: { "@mc/schemas/*": ["../src/schemas/*"] }
    components.json                 # shadcn config
    src/
      main.tsx                      # AuthProvider + RouterProvider + QueryClientProvider
      routeTree.gen.ts              # generated by @tanstack/router-plugin (gitignored)
      routes/                       # file-based routes (TanStack Router flat-file style:
                                    # dotted names map to nested URLs; `_` prefix = layout route)
        __root.tsx
        index.tsx                   # / → redirect
        sign-in.tsx
        sign-up.tsx
        forgot-password.tsx
        reset-password.tsx
        verify-email.tsx
        magic-link.tsx
        accept-invitation.tsx
        onboarding.create-org.tsx
        _authed.tsx                 # auth-guard layout
        _authed.tasks.tsx           # /tasks
        _authed.tasks.$taskId.tsx   # /tasks/$taskId
        _authed.events.tsx          # /events
        _authed.projects.tsx
        _authed.projects.$projectId.tsx
        _authed.agents.tsx
        _authed.agents.$agentId.tsx
        _authed.connectors.tsx
        _authed.connectors.$connectorId.tsx
        _authed.settings.tsx        # /settings layout (sidebar nav inside this layout)
        _authed.settings.profile.tsx
        _authed.settings.sessions.tsx
        _authed.settings.api-keys.tsx
        _authed.settings.organization.tsx
        _authed.settings.organization.members.tsx
        _authed.settings.organization.invitations.tsx
      components/
        ui/                         # shadcn-generated primitives
        auth/                       # better-auth-ui-shipped (auth.json)
        settings/                   # better-auth-ui-shipped (settings.json)
        user-button/                # better-auth-ui-shipped (user-button.json)
        app-shell/                  # custom: TopBar, Sidebar, OrgSwitcher, ThemeToggle
        agents/                     # custom: AgentsTable, RegisterAgentDialog, etc.
        connectors/
        projects/
        tasks/
        events/
        api-keys/
        organization/
      lib/
        auth-client.ts
        api.ts
        error-messages.ts
        query-client.ts             # QueryClient singleton + invalidation helpers
        utils.ts                    # shadcn cn()
      hooks/
        use-active-org.ts
        use-switch-org.ts
        ...
      emails/                       # better-auth-ui-shipped email templates (if not auto-placed)
    test/
      setup.ts                      # MSW setup, RTL config
      components/                   # component tests
      e2e/                          # Playwright tests
    package.json                    # web-specific deps; participates in workspace
    eslint.config.js
  wrangler.jsonc                    # adds assets block + EMAIL binding
```

---

## 16. What v1 ships

- ✅ SPA bound to the existing MC Worker via Workers Assets, deployed in one `wrangler deploy` artifact.
- ✅ All auth flows (sign-up, sign-in, verify, magic-link, reset password) via better-auth-ui shipped components, backed by Cloudflare Email Send.
- ✅ Profile / sessions via better-auth-ui shipped components.
- ✅ Custom UI for org create/switch/manage, members, invitations.
- ✅ Custom UI for PATs (mint / list / revoke).
- ✅ Custom UI for agents, connectors, projects (full CRUD + key mint / rotate / one-shot reveal).
- ✅ Read-only tasks list (filters, cursor pagination) + detail (comments / events / external refs tabs).
- ✅ Read-only events log viewer (virtualized).
- ✅ API path rename `/v1/*` → `/api/v1/*` with all 469 tests updated.
- ✅ Hermes plugin updated to the new URL convention (env var = base without `/v1/`).
- ✅ Zod schema extraction into `src/schemas/*` with UI consuming types via tsconfig path alias.
- ✅ Vitest component tests + Playwright E2E happy paths.

---

## 17. What's deliberately deferred

| Item | Why deferred |
|---|---|
| Task create / edit / status change / comment from UI | Notion remains the human-facing task surface for v1 per the master API spec. |
| Kanban-style task board | Read-only scope; would imply mutation affordances we don't ship. |
| OAuth / social login | Email + magic link covers v1; adding providers is config-only when needed. |
| MFA / 2FA | better-auth supports it; UI wiring is a separate pass. |
| Optimistic UI updates | Cost > benefit at v1 polish level. |
| Persistent query cache (IndexedDB) | Refresh-as-refetch is fine at operator scale. |
| SSE / streaming events | 30s polling is sufficient; latency isn't a v1 concern. |
| OpenAPI / Swagger UI doc gen | Schema layout sets this up; the gen pass is its own work. |
| Notion-task-from-UI deep link | Single "View in Notion" link could land later via external_refs. |
| Visual regression tests | Adds CI complexity; revisit when a real designer needs it. |
| Cross-browser test matrix | Chromium-only Playwright in v1. |
| Content Security Policy headers on SPA responses | Workers Assets default headers are fine for v1; tighten in a security pass after launch. |
| UI-side observability (web vitals, error reporting, Sentry/PostHog wiring) | Server-side request logging (Hono's logger middleware, already in place per the master spec) covers v1; client error reporting waits for first user. |
| Secret rotation runbook for BETTER_AUTH_SECRET / EMAIL provider keys | Operational docs lag the v1 deploy; will be added when first rotated. |

---

## 18. Known inconsistencies with sibling specs (flagged, not resolved here)

1. **Hard prerequisite — bootstrap user must be pre-verified.** The master spec's `POST /v1/bootstrap` handler must set `emailVerified: true` on the user it creates (the operator-supplied admin email is presumed verified by virtue of `MC_ADMIN_TOKEN` possession). Without this change the bootstrap user cannot sign into the UI once `requireEmailVerification: true` is set (better-auth blocks unverified accounts at sign-in). **This change ships as part of the MC UI work** — it is not a separate session — but the master spec is updated to reflect it. Implementation step in the plan.
2. **Master API spec § "Deployment model" / "Repo layout" / "Local OSS Docker target":** describes an "OSS self-hoster" running `wrangler dev` directly inside a Docker container against a local SQLite-backed D1. This spec assumes "self-host" means self-hosted on Cloudflare (per session decision). The contradiction does not block v1 UI work — `wrangler deploy` works identically — but the master spec should be amended in a dedicated session to either drop the local-Docker path or carve it out explicitly. The local-Docker path is the only place where the chosen email-provider binding would not exist; resolution of that is owed when the master spec is updated.
3. **`/v1/events` filter capabilities:** the master API spec defines `kinds` as a comma-separated `resource_type` list, not per-resource filtering. The task detail's "View all events" link in §8 assumes `resource_type=...&resource_id=...` query params; if those aren't supported, the link degrades to a filter-prefilled view of all task-kind events. Either acceptable for v1 or a small API enhancement — flagged for the implementer.

---

## 19. Open questions for review

1. **`<AccountSettings />` monolith vs split.** better-auth-ui ships `<AccountSettings />` (combined) and individual cards (`<UserProfile />`, `<ChangePassword />`, `<ChangeEmail />`, etc.). v1 uses the monolith for simplicity. If post-implementation feedback says it's too dense, split into a tabbed `/settings/profile` with one tab per concern. Not a v1 blocker either way.
2. **Project task-count badge.** Implementing this naively (`GET /api/v1/tasks?project_id=...&limit=1` and reading `next_cursor` presence) wastes a request per project for a cosmetic count. If profiling shows it's expensive, drop the badge; the master API spec does not currently expose a project-task-count endpoint. v1 ships with the badge unless the implementer flags it.
3. **Dev-mode response validation.** Whether to enable the `validateResponses()` middleware in v1 (logs response-shape drift in non-prod) — implementer's call after the schema extraction lands.
4. **react-json-view library choice for the events payload viewer.** Many options (`react-json-view-lite`, `@uiw/react-json-view`, custom <pre>); implementer picks based on bundle size + maintenance, not worth pre-deciding here.
