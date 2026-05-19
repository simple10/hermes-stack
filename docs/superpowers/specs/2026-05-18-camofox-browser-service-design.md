# Camofox-Browser Service — Design

**Date:** 2026-05-18
**Status:** Approved (user waived the spec-review gate; self-review only)
**Goal:** Add `jo-inc/camofox-browser` (stealth headless-browser automation API for AI agents) as an opt-in stack service, operational only. Hermes-side wiring is explicitly **out of scope** — the user configures Hermes.

## What it is

Camofox-Browser is a single Node.js (>=22) HTTP server wrapping **Camoufox**
(a Firefox fork with C++-level fingerprint spoofing) for anti-bot browser
automation. REST API on port **9377**: `/health` (unauthenticated),
`/tabs` (+ `/tabs/:id/{snapshot,click,navigate,…}`), `/youtube/transcript`,
`/sessions/:userId/cookies`, `/openapi.json`, `/docs`. It is also an OpenClaw
plugin (`openclaw.plugin.json`), which is why Hermes can target it as a
configured browser provider.

## Source review — requirements (the deciding facts)

| Question | Finding |
|---|---|
| Official image? | **None published.** Build from source. |
| Build path | Repo ships `Dockerfile` (needs `make fetch` → BuildKit bind-mount of `dist/`) **and** `Dockerfile.ci` (self-contained: downloads the already-pinned Camoufox `v135.0.1-beta.24` + `yt-dlp` at build time, keyed on `TARGETARCH`). Railway uses `Dockerfile.ci`. |
| External services | **None.** No Postgres / Redis / RabbitMQ / LiteLLM. Fully standalone. |
| Port / protocol | `9377` HTTP REST. Health: `GET /health` (no auth). |
| Auth | `CAMOFOX_ACCESS_KEY` = bearer for all routes except `/health` & `/stop`. `CAMOFOX_API_KEY` gates cookie import; `CAMOFOX_ADMIN_KEY` gates `/stop`. All optional. |
| Heap | `node --max-old-space-size=${MAX_OLD_SPACE_SIZE:-128}` (Dockerfile CMD). |
| Resources | ~40 MB idle (lazy launch + auto-shutdown); grows with concurrent tabs/Firefox. |
| Persistence | `~/.camofox/{profiles,cookies,traces}` (container runs as root → `/root/.camofox`). Browser binary lives separately at `/root/.cache/camoufox` (volume does NOT shadow it). |
| Plugins | `camofox.config.json` enables `youtube`, `persistence`, `vnc` by default. Left as-is (no customization requested — YAGNI). |

## Decision: build from pinned `_source/` via `Dockerfile.ci`

Exact **honcho/honcho-ui precedent** (`services/<svc>/_source/` is a git clone
pinned to a SHA, gitignored by `.gitignore:6 **/_source/`; `build.sh` prepares
it; `compose.yaml` has `build: { context: ./_source }`). `Dockerfile.ci`
chosen over `Dockerfile` because it is self-contained (no `make fetch`
pre-stage, no BuildKit bind-mount, no duplicated arch logic) and the Camoufox
version is already ARG-pinned in it. Reproducible via the `_source` SHA pin +
the in-Dockerfile version pins. Apple-Silicon/OrbStack builds native arm64
(`TARGETARCH=arm64` → Camoufox arm64 release). Rejected: prebuilt-registry
(upstream publishes none); `make fetch` + default `Dockerfile` (more moving
parts, marginal gain).

**Pinned source ref:** `c9a90dafc76d2dfa0eb5d74fa36ef28f3ba98b29`
(`jo-inc/camofox-browser` `master`, 2026-05-12, "chore: update lockfile for
camoufox-js >=0.10.0").

## Architecture

One standalone service `camofox-browser`. Opt-in Compose profile
`[camofox-browser]` (off by default, like `[hindsight]`/`[firecrawl]`).
Project-scoped: no `container_name`, no host `ports:`, no custom network.
Reachable as `camofox-browser.<project>.orb.local:9377` and by sibling
containers as `camofox-browser:9377`. **No** provisioner, preflight, prestart,
or poststart — nothing to mint or order (no backend dependencies).

### Files — Create `services/camofox-browser/`

- **`build.sh`** (mirrors `services/honcho/build.sh`):
  1. `set -euo pipefail`; source `lib/stacklib.sh`.
  2. **Generated secret, read-existing-first** (honcho-DB-password / firecrawl-BULL-key pattern): `key="$(env_get "$GEN" CAMOFOX_ACCESS_KEY)"; [ -n "$key" ] || key="$(openssl rand -hex 32)"; env_upsert "$GEN" CAMOFOX_ACCESS_KEY "$key"` where `GEN="$STACK_DIR/camofox-browser.generated.env"` (`env_upsert` `chmod 600`s it; it reaches Compose only via `dc`'s hermetic `--env-file`).
  3. **Clone-if-absent / reuse**: if `_source/Dockerfile.ci` exists → reuse; else `git clone https://github.com/jo-inc/camofox-browser "$D/_source"`, `git -C "$D/_source" checkout c9a90dafc76d2dfa0eb5d74fa36ef28f3ba98b29`, `rm -rf "$D/_source/.git"`.
  4. **Eager build** (honcho-ui precedent — surface build failures at `just build`, not `just start`): `dc build camofox-browser`.
- **`compose.yaml`**:
  ```yaml
  services:
    camofox-browser:
      build: { context: ./_source, dockerfile: Dockerfile.ci }
      profiles: [camofox-browser]
      restart: unless-stopped
      expose: ["9377"]
      environment:
        CAMOFOX_PORT: "9377"
        CAMOFOX_ACCESS_KEY: ${CAMOFOX_ACCESS_KEY}
        MAX_OLD_SPACE_SIZE: ${CAMOFOX_HEAP_MB:-128}
      volumes:
        - camofox-data:/root/.camofox
      healthcheck:
        test: ["CMD-SHELL", "curl -fsS http://localhost:9377/health || exit 1"]
        interval: 10s
        timeout: 6s
        retries: 20
        start_period: 30s
      cpus: ${CAMOFOX_CPU:-2}
      mem_limit: ${CAMOFOX_MEM:-2g}
      logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
  volumes:
    camofox-data:
  ```
  Rationale: `start_period: 30s` covers Camoufox/Xvfb first-boot;
  `/health` is unauthenticated so the healthcheck needs no key; `curl` is
  installed by `Dockerfile.ci`. `/root/.camofox` (data) ≠
  `/root/.cache/camoufox` (baked binary) — the volume does not shadow it.

### Modify

- `docker-compose.yaml` — `include:` += `services/camofox-browser/compose.yaml` (last).
- `.stack.env.example` — document the opt-in `camofox-browser` profile + optional levers `CAMOFOX_MEM` / `CAMOFOX_CPU` / `CAMOFOX_HEAP_MB`. Note `CAMOFOX_ACCESS_KEY` is **generated** (not hand-edited; not added to the schema). `COMPOSE_PROFILES` default value unchanged.
- `README.md` — service entry under the services list + tree comment line.
- `lib/setup.sh` — **no change**: every Compose var is either generated (`CAMOFOX_ACCESS_KEY`) or has a `:-default` (`CAMOFOX_{MEM,CPU,HEAP_MB}`), so none can interpolate empty (the bug that forced `FIRECRAWL_MODEL` into setup.sh does not apply).

### Hermetic-config compliance

`CAMOFOX_ACCESS_KEY` lives only in `.stack/camofox-browser.generated.env` and
reaches the container solely through `dc`'s hermetic `--env-file` (gotcha
#16). No `${HOST_VAR}` reads added anywhere. `just build` runs
`services/camofox-browser/build.sh` because the profile name == the service
dir name.

## Out of scope (explicit)

- **All Hermes-side wiring.** No `machines/hermes/` changes. After bring-up
  the deliverable is: the endpoint (`http://camofox-browser.<project>.orb.local:9377`)
  + the generated `CAMOFOX_ACCESS_KEY` value, handed to the user to configure
  Hermes themselves.
- Customizing/stripping the upstream youtube/persistence/vnc plugins.
- Exposing VNC (only `9377` is exposed).
- `CAMOFOX_API_KEY` (cookie-import) / `CAMOFOX_ADMIN_KEY` (`/stop`) — left
  unset; not needed for "operational". Easily added later as generated keys.

## Acceptance

1. `COMPOSE_PROFILES` includes `camofox-browser` → `just build`:
   `build.sh` generates `CAMOFOX_ACCESS_KEY` into
   `.stack/camofox-browser.generated.env` (idempotent: re-run reuses it),
   clones+pins `_source/`, `dc build` produces the image.
2. `just start` → `camofox-browser` container reaches **healthy**
   (`GET /health` → 200, no auth).
3. With the generated bearer: an authenticated request (e.g.
   `POST /tabs {"url":"https://example.com"}` then `GET /tabs`) over the
   orb DNS succeeds; the same request **without** the bearer is rejected
   (proves the access key is enforced).
4. `camofox-browser` absent from `COMPOSE_PROFILES` → stack unaffected
   (nothing built or run; no other service touched).
5. Validation occurs **only** in an isolated throwaway Compose project
   (the sub-project-1/firecrawl venue); the live `aitools` stack and its
   `.stack/` are never mutated; the hermetic-config invariant holds.

## Risks / validation points

- First build is heavy (apt Firefox/Xvfb deps + ~300 MB Camoufox download) —
  a few minutes; needs build-time network (acceptable; honcho's does too).
  Resolve at the validation step (confirm `dc build` succeeds in the isolated
  project on this arch).
- `arm64` Camoufox release availability for the pinned version — confirmed by
  upstream `Dockerfile.ci`'s `arm64` branch; verified at the build step.
- Healthcheck path is `/health` (open) — confirmed in source review; if a
  build pins a server variant without it, fall back to a TCP probe on 9377
  (decided at validation).
