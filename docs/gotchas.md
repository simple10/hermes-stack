# Gotchas

Hard-won. Read before debugging.

## 1. `xz-utils` is required inside the Hermes VM

The Hermes installer extracts a Node `.tar.xz`; minimal Ubuntu doesn't
ship `xz-utils`. `services/hermes/build.ts` apt-installs it (along
with `curl`, `ca-certificates`, and `git`) before running the
installer.

## 2. Honcho embedding dim is fixed at first provisioning

Alembic hardcodes `vector(1536)` in the migration; the `honcho-schema`
provisioner ALTERs the empty `documents` / `message_embeddings`
columns to `EMBEDDING_VECTOR_DIMENSIONS` (set to `1024` on the
honcho-api/deriver/schema services). The dim cannot be changed once
the columns hold rows — an out-of-band re-embed migration is out of
scope.

`configure_embeddings.py` refuses a populated column and no-ops when
the dim already matches, so the provisioner is safe + idempotent on
every start.

## 3. The `.stack/.env` file is not auto-loaded by Compose — that's deliberate

Every compose call goes through `lib/dc.ts`, which passes `.stack/.env`
+ every `.stack/*/.generated.env` as absolute `--env-file` args, under
a tightly-stripped host environment. Running `docker compose up` from
the repo root yourself will fail fast (no env), guarding against
accidental parent-`.env` walking.

The strip matters: Compose interpolation precedence is `host-env >
--env-file`, so a stray exported `POSTGRES_SUPERPASS` or
`COMPOSE_PROFILES` would silently outrank the real `.stack` value.
`dc()` uses `env -i` with a tight docker-operational allowlist (PATH,
HOME, DOCKER_*, *_PROXY) so the host environment literally isn't
present to win.

## 4. PG rebuild / fresh project wipes the LiteLLM DB → stored virtual keys become invalid

`services/litellm/preflight.ts` self-heals: it tries `/key/update` and,
if the key isn't valid in this DB (fresh / rotated / volume recreated),
re-mints and overwrites `.stack/litellm/.generated.env`. Recreating a
stack from scratch Just Works on the next `./stack-cli start`.

## 5. The LiteLLM `chatgpt/*` responses-bridge is non-streaming-broken

Known upstream bug. Use `cliproxy/*` instead (plain OpenAI-compatible
upstream → CLIProxyAPI), which is verified working for both streaming
(Hermes) and non-streaming (Honcho / agentmemory / hindsight). The
`chatgpt/*` model entries are kept ONLY for rollback.

The constraint is enforced not by per-key model allowlists (virtual
keys are unrestricted) but by the explicit per-service `*_MODEL`
levers in `.stack/.env` — never set one to a `chatgpt/*` value.

## 6. OrbStack machine "Logs" tab is `/dev/console`, not journald

`hermes-logtail` (root) mirrors `~/.hermes/logs/{gateway,errors}.log`
to `/dev/console` so they appear in the Logs tab. `agent.log` is
intentionally excluded (DEBUG-spam).

If you set `HERMES_LOGTAIL_DASHBOARD=true`, the logtail also tails
`journalctl -fu hermes-dashboard` (which has no file log).

## 7. `hermes-agent` is the frozen original — never modified

`services/hermes/build.ts` hard-refuses VM name `hermes-agent`. The
clone (`hermes` by default) is the working machine.

## 8. ChatGPT `auth.json` is a required runtime artifact

Without it, LiteLLM blocks on an interactive device-code prompt at
boot and never goes healthy. On a fresh install complete the device
pairing once (it persists in `.stack/litellm/chatgpt/auth.json`).

## 9. DNS is project-scoped: `<service>.<project>.orb.local`

Services have no `container_name:` and the project name is a
deliberate, configured value (`COMPOSE_PROJECT_NAME`), so the
project-qualified OrbStack name is stable and is what isolates
stacks. The hermes config templates carry a `__STACK_PROJECT__`
placeholder that `services/hermes/build.ts` substitutes (e.g.
`litellm.aitools.orb.local`).

Within a stack, containers reach each other by plain service name on
`<project>_default`.

## 10. agentmemory ≥0.9.18 runs an interactive first-run wizard

Whenever `~/.agentmemory/preferences.json` is missing, the wizard
fires; on a non-TTY it `process.exit(0)`s, so the container
crash-loops. The entrypoint pre-seeds `preferences.json` ("onboarding
complete") to skip it.

## 11. Adding a pg-using service is purely additive — no `00-init.sql`

Each service owns its `<SVC>_DB_PASSWORD` in
`.stack/<svc>/.generated.env` (its `build.ts` reads-or-gens — never
blind-regen) and ships a `provision.sql` + a one-shot
**`com.stack.role=provisioner`** Compose service. Provisioners run
every `./stack-cli start`, idempotently. A service may chain >1
(e.g. honcho: `honcho-provision` for role/db/ext → `honcho-schema`
for migrate + `configure_embeddings`).

## 12. PG extension binaries / `shared_preload_libraries` / global `ALTER SYSTEM` are NOT a provisioner's job

Postgres data lives in the `<project>_pg-data` volume, independent of
image/config. Changing the git-tracked `services/pg/` definition and
`dc up -d pg` recreates **only** the `pg` container, re-mounting the
volume — non-destructive within a PG major. (Major version bumps are
data-destructive; out of scope.) In-database role/db/extension stays
in the per-service provisioner.

## 13. Firecrawl uses a DEDICATED `firecrawl-postgres`, never the shared pg

`nuq-postgres` is a purpose-built appliance: `pg_cron`
`shared_preload_libraries` + cluster-wide `ALTER SYSTEM` + ~40 cron
jobs that ARE the queue engine. It self-initializes its own
single-tenant `firecrawl-pg-data` volume.

## 14. Self-hosted Firecrawl has NO interactive browser-session feature

The v2 `/browser*` routes + `scrape-browser` (and `/v2/scrape` with
browser `actions`/agent mode) are gated on `BROWSER_SERVICE_URL` — a
browser service upstream **does not ship for self-host**. Calling
them returns `503 "Browser feature is not configured"`.

Use the supported path: `/v1/scrape|crawl|extract` or `/v2/scrape`
WITHOUT browser actions (the playwright scrape engine via
`PLAYWRIGHT_MICROSERVICE_URL`, which IS wired).

## 15. Multi-stack DNS is flat by design

OrbStack's `<service>.<project>.orb.local` resolves from any VM,
regardless of which project that VM belongs to (OrbStack has no
project namespace concept). Per-stack scoping is *configuration*, not
enforcement: `services/hermes/build.ts` bakes `<svc>.${PROJ}.orb.local`
URLs into the building stack's Hermes config, so hermes-A only talks
to stack A unless you point it elsewhere by hand.

`--isolate-network` blocks Mac IPs + sibling VMs but does NOT scope
container DNS — an isolated hermes-A *could* still resolve
`litellm.lab.orb.local` if a compromised dep tried. This stack's
threat model is single-user-multi-stack (you trust your own work);
the isolation flags defend against compromised deps reaching the Mac
host, not against cross-stack container access.

## 16. OrbStack inherits the caller's `HTTP_PROXY` into the VM

OrbStack passes the calling process's `HTTP_PROXY`/`HTTPS_PROXY` env
vars into the VM shell, rewriting `127.0.0.1` to `host.orb.internal`.
Combined with `--isolate-network` (which blocks Mac IPs from the VM),
this turns every `curl` inside the VM into a 7 "connection refused".

If you've got a host-side package manager wrapper (PMG, corepack
mirror, etc.) that sets `HTTP_PROXY` on its subprocesses, `stack-cli`
strips proxy vars before spawning `orb` (`lib/orb.ts`). If you ever
add a new path that shells out to `orb`, route it through `orbExec` /
`orbShell` (or remember to strip).

## 17. The Hermes installer wants a writable `/opt` and an empty (not pre-created) install dir

The installer's `git clone` runs as the invoking user — so `/opt`
needs to be writable by them, AND `/opt/hermes-agent` must NOT
exist as an empty dir (the installer refuses to clone into one).
`services/hermes/build.ts` chowns `/opt` to the remote user and
rmdir's `/opt/hermes-agent` if it's empty before running the
installer.

## 18. Don't override `git author email` in commits

The repo's git config uses a noreply email by convention. Don't pass
`-c user.email=…`, `--author=…`, or `GIT_AUTHOR_EMAIL=` to git.
Just `git commit`.

## 19. Backup `.stack/` to repo-root `_bak/`, never `/tmp`

`.stack/.env` holds secrets; `/tmp` is world-readable and gets
forgotten. The convention is `_bak/.stack.<timestamp>/` (gitignored).
