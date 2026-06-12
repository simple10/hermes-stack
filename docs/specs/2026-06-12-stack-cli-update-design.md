# `stack-cli update` — version discovery, bumping, and display

**Status:** draft · **Date:** 2026-06-12 · **Branch:** `feat/stack-cli-update`

## Problem

Many components of the stack update upstream frequently. Today, bumping a service is manual and under-discoverable:

- For tag-pinned services you edit a `*_VERSION` in `.stack/.env`, then `restart` (plain tag) or `build && restart` (digest-resolved).
- For digest-pinned services (litellm, firecrawl, hindsight, hermes-workspace) there is **no `*_VERSION` knob in `.stack/.env` at all** — you must read `service.yaml`/`images.ts` to even learn the key exists.
- There is no way to ask "what newer versions are available?" and no visibility into what version is actually running.

This spec covers four things:

1. **Universal version knobs** — every versioned service surfaces an editable `*_VERSION` line in its `.stack/.env` block.
2. **Human-readable running-version display** in `stack-cli info` and the `start` summary.
3. **`stack-cli update [svc]`** — read-only "outdated" report + targeted apply.
4. **Per-service update policy** (`update:` block) with a user-overridable channel, respecting the git boundary.

Whole-stack `stack-cli update --latest` is **out of scope** for v1 (deferred).

## Background: how versions are pinned today

Five pin-types (see `memory/stack-cli-update-design.md` for the full per-service table):

| Type | Mechanism | Services | Apply |
|---|---|---|---|
| (a) plain registry tag | `image: repo:${X_VERSION}` interpolated from `.stack/.env` | pg, redis, cliproxyapi, searxng, rabbitmq | bump → `restart` |
| (b) digest via `service.yaml images:` | `*_VERSION` → resolved `@sha256` in `.generated.env` | litellm, agentgateway, phoenix, firecrawl×3, hindsight, tensorzero×3, hermes-workspace | bump → `build` → `restart` |
| (c) built from source | `source: {repo, default:<sha>}` → resolved SHA | honcho, honcho-ui, portkey, browser-use, camofox-browser | bump → `build` → `restart` |
| (d) VM installer | `ensureNode` / hermes-agent installer | hermes | `build` |
| (e) hardcoded build args | npm vers in compose `args:` | agentmemory | manual |

**Knob conventions already in code:**
- images: `versionKey = ${decl.name}_VERSION` (`images.ts:39`) — `decl.name` is the `images:` map key (`PHOENIX`, `LITELLM`, `FIRECRAWL_API`).
- source: `${SVC_UC}_VERSION` where `SVC_UC = svc.toUpperCase().replace(/-/g,'_')` (`source.ts:19`).
- Resolution precedence (both): `stackGet(key) || process.env[key] || default`.

**`.stack/.env` block model** (`stack.ts`): per-service blocks delimited by `#>--- <svc> ---` / `#<--- <svc> ---`; disabled blocks are line-prefixed with `# `. `stackGet`/`stackUpsert` are block-aware via an owner map built from each service's `env:` body (`services.ts:stackEnvOwnerMap`). `blockSync(svc, schema)` additively adds *missing* keys (idempotent). The owner map currently does **not** know about `images:`/`source:` version keys — which is exactly why digest services don't seed a knob.

**Carve-outs for v1:** hermes VM (d) and agentmemory (e) stay manual; firecrawl/tensorzero multi-image groups are treated as a lockstep unit for `update`.

---

## Part 1 — Universal version knobs

**Goal:** every image/source service has exactly one human-editable `*_VERSION` line in its `.stack/.env` block; the immutable `@sha256`/SHA stays in `.generated.env` as the lock.

### Changes

1. **Owner map** (`services.ts:stackEnvOwnerMap`): in addition to `env:` keys, register the derived version key for every `images:` decl (`<NAME>_VERSION`) and `source:` decl (`<SVC_UC>_VERSION`) → owned by that service. This is the load-bearing change: it makes `stackGet`/`stackUpsert` treat e.g. `LITELLM_VERSION` as block-owned (read in-block, writable in-block, refuses when the block is disabled).

2. **New helper** `serviceVersionKnobs(svc): { key, default, repo, kind: 'image'|'source', imageName? }[]` in `services.ts` (or a small `versions.ts`). Single source of truth for "what version knobs does this service have, and their defaults" — consumed by seeding, display, and update.

3. **Seeding** (`stack.ts`): when building the schema passed to `blockSync` for a service, append synthesized `\n<KEY>=<default>` lines for each knob from `serviceVersionKnobs(svc)` that the maintainer didn't already hand-declare in `env:`. Because `blockSync` only adds missing keys, this is idempotent and never clobbers a user edit. Existing enabled services pick the knob up on the next `enable`/`build`/`reconfigure`; new enables get it immediately.

4. **Schema cleanup (docs + service.yaml):** prefer a human **tag** in `images.default` (the digest belongs in the `.generated.env` lock, not the source file). `resolveImage` already passes `sha256:` through and resolves a tag → digest, so both forms keep working; moving defaults to tags is what makes the seeded knob human-bumpable. Remove the now-redundant hand-declared `PHOENIX_VERSION`/`AGENTGATEWAY_VERSION` from their `env:` blocks (the auto-seed is the single source). Genuinely tag-less pins keep the digest as the seeded value and are excluded from channel updates.

### Result

Bumping any service = edit one in-block line + `stack-cli build && stack-cli restart <svc>` (or `stack-cli update <svc>`), with no need to read `service.yaml` or build code.

---

## Part 2 — Human-readable running-version display

**Goal:** `stack-cli info` and the `start` summary show each service's *running* version as a tag where possible.

### Data sources (priority)

For each service, derive a display version:
1. **Running container** (`ServiceHealth.image`, already parsed from `docker ps {{.Image}}`): if it's `repo:tag`, show the tag. If it's `repo@sha256:…`, it has no human tag — fall through.
2. **`.generated.env` `<NAME>_IMAGE_REQUESTED` / `<SVC_UC>_SOURCE_REQUESTED`**: the value the user/maintainer requested (a tag, a `sha256:`, or a git ref). Tag → show as-is; `sha256:`/SHA → short form `abc123def456…` (12 chars).
3. **Knob default** from `serviceVersionKnobs` if nothing resolved yet (service not built/running).

Show a subtle drift marker when the running image digest ≠ the resolved-digest in `.generated.env` (i.e. "running an older build than the current pin") — e.g. a trailing `*` or dim `(drift)`.

### Changes

- Extend `ServiceHealth` (`health.ts:20`) with `version?: string` (and optionally `versionDrift?: boolean`).
- Enrich in `getStackHealth()` (or a thin pass in `info.ts` after the snapshot) using `serviceVersionKnobs` + `generatedGet` + the parsed `image`.
- `formatServiceLines` (`render-health.ts:59`) appends the version as a dim column, e.g.:
  `●  phoenix    running, healthy   v16.3.0   aitools-phoenix-1`
  Digest-only: `●  litellm    running, healthy   069da885c7bf…`
- `start.ts` already ends with `await runInfo()` (`start.ts:91`), so the start summary inherits the column for free.

---

## Part 3 — `stack-cli update [svc]`

### CLI surface (`cli.ts`)

Register via the existing `perSvc(verb, one, whole)` helper:
```
update: perSvc('update', updateService, updateAll)
```
- `stack-cli update` (no args) → `updateAll`: read-only outdated report across enabled services.
- `stack-cli update <svc>…` → `updateService(svc)`: by default interactive (list candidates, pick); flags:
  - `--to <version>` — pin an explicit version.
  - `--channel <name>` — set/track a channel (writes the override key, see Part 4).
  - `--check` — read-only for a single service (no mutation).
  - `--yes` — non-interactive: take the channel's newest and apply.

Add a `HELP_SECTIONS` row.

### Discovery adapters (the only new I/O)

`scripts/lib/version-sources/` — one adapter per upstream kind, each `listVersions(repo): Promise<string[]>` returning candidate tags/refs (newest-first after filter+sort):
- `dockerhub` — `GET https://hub.docker.com/v2/repositories/<repo>/tags?page_size=100`.
- `ghcr` — OCI `GET https://ghcr.io/v2/<name>/tags/list` with an anonymous bearer token.
- `github-releases` / `github-tags` — `gh api repos/<owner>/<repo>/releases` or `/tags` (use the sanctioned `gh` CLI).
- `npm` — `GET https://registry.npmjs.org/<pkg>` → `dist-tags` (agentmemory, later).
- `node-dist` — reuse the `nodejs.org/dist/latest-vN.x/` logic from `ensureNode` (hermes, later).

Adapter selection is **inferred** from the service's `images.repo` host / `source.repo` host, overridable by `update.source` (Part 4). Candidate list is filtered by the active channel regex and sorted by `update.sort` (semver|date).

### Apply pipeline (`commands/update.ts`)

For a chosen version on service `svc`:
1. `_bak/` snapshot of `.stack/.env` (+ relevant `.generated.env`) — see `memory/stack-env-backup-location.md`.
2. `stackUpsert('<KEY>', chosenVersion)` — block-aware write of the knob.
3. Re-resolve: run the service's image/source resolution (`resolveImage`/`stackSource`) so `.generated.env` gets the new digest/SHA lock. (Per-service resolve; `runBuild` Phase-1 logic factored to accept a single service.)
4. If the service builds from source or needs config render, run its `build.ts`.
5. `restartService(svc)` (stop+recreate → re-reads `.stack/.env`).
6. **Health-gate:** poll `getStackHealth()` until the service is healthy or a timeout; on failure, restore the `_bak/` snapshot and `restart` again (rollback), and report.

`updateAll` runs only step 0-discovery for every enabled service and prints `current → latest` (no mutation), with a hint to run `update <svc>` to apply.

---

## Part 4 — Update policy & channel override (git boundary)

**Rule:** `service.yaml` (git-tracked) holds **declarative policy only**; `.stack/.env` (gitignored, per-service block) holds **all mutable user state**. A user preference is *never* written to `service.yaml`.

### `update:` block in `service.yaml` (shipped default policy)

```yaml
update:
  channels:
    stable: '^v\d+\.\d+\.\d+$'
    beta:   '-(rc|beta)\.\d+$'
  default: stable          # tracked when the user expresses no choice
  sort: semver             # semver | date
  source: ghcr             # optional; otherwise inferred from repo host
```
Optional; absent ⇒ infer source from repo host, single implicit `stable` channel, semver sort.

### User override (`.stack/.env`, gitignored)

The user's active channel is `<NAME>_UPDATE_CHANNEL` inside the service block:
```
#>--- litellm ---
LITELLM_VERSION=v1.40.0
LITELLM_UPDATE_CHANNEL=beta
#<--- litellm ---
```
Precedence (mirrors version resolution): `stackGet('<NAME>_UPDATE_CHANNEL') || update.default`. Register `<NAME>_UPDATE_CHANNEL` in the owner map so it's block-aware and seedable (seeded commented/blank by default).

### Beta opt-in walkthrough (litellm: stable → beta)

- **Command:** `stack-cli update litellm --channel beta`
  1. `stackUpsert('LITELLM_UPDATE_CHANNEL','beta')` (block-aware; refuses if block disabled).
  2. channel `beta` → regex `-(rc|beta)\.\d+$`; discovery on `ghcr.io/berriai/litellm-database`; filter+semver-sort → newest, e.g. `v1.41.0-rc.2`.
  3. apply pipeline (snapshot → `stackUpsert LITELLM_VERSION` → resolve digest → build → restart → health-gate).
- **Manual, same outcome:** edit `.stack/.env` (`LITELLM_UPDATE_CHANNEL=beta`, optionally pin `LITELLM_VERSION`), then `stack-cli build && stack-cli restart litellm`.
- **`git pull` is conflict-free:** upstream may change regexes/default in `service.yaml`; the user's gitignored channel + pin are untouched, and an explicit channel still wins by precedence.
- **Revert:** `stack-cli update litellm --channel stable`, or delete the channel key (falls back to shipped `default: stable`).

---

## Part 5 — Health: out-of-band signal + auto-healing compose probes

**Motivation:** twice (phoenix lost `/bin/sh`, cliproxy lost `wget`) a version bump silently broke a *compose* healthcheck while the app was fine — `unhealthy` despite `/healthz` 200. A naive update health-gate would falsely roll back a working bump. Two layers, decided here:

### 5a. Out-of-band probe (stack-authoritative) — drives info/start AND the update gate

The stack runs its OWN probe of the service's declared endpoint, independent of in-container tooling. Source of truth for `info`/`start` health and the P4 health-gate.

- `service.yaml` gains an optional `health:` block:
  ```yaml
  health:
    path: /healthz   # HTTP GET on the provides endpoint; success = 2xx (default if a web provides exists)
    port: 8317       # default: primary provides port
    expect: 200      # default: any 2xx
    # non-HTTP services instead declare:
    tcp: true        # success = TCP connect to port (pg/redis)
  ```
  Absent ⇒ default to HTTP `/healthz` when the service has an HTTP `provides`, else TCP-connect on the primary provides port.
- Probe runs from the host via orb DNS (`<svc>.<project>.orb.local:<port>`). Used as `ServiceHealth.version`'s sibling — info shows a stack-derived health, not just Docker's `(healthy)`. This also gives services with NO image healthcheck (agentgateway) a real signal.

### 5b. Auto-healing in-container healthcheck (generated, build-time, folded into P4 apply)

Docker's native healthcheck still matters for `depends_on: condition: service_healthy` ordering — **pg, redis, litellm are depended on this way** by honcho/hindsight/firecrawl/browser-use/phoenix-provision, so their probe is load-bearing (a broken one HANGS dependents at startup). The in-container probe is RESOLVED at build (re-evaluated every build, and by the P4 apply pipeline after a bump), by this precedence:

1. **Image ships its own HEALTHCHECK** (`docker inspect <resolved-image> --format '{{json .Config.Healthcheck}}'` ≠ null, inspect the IMAGE not the container) → inherit it; emit nothing. *Official.*
2. **`service.yaml health.exec`** (author-vouched in-container CMD, e.g. `pg_isready`) → emit it.
3. **Neither** → emit the **universal `/proc/net/tcp` LISTEN probe** on the primary provides port (needs only `/bin/sh`+`grep`; no HTTP client; no `$` — compose interpolates `$`/`${}`). NOT tool-sniffing (no wget/curl/nc matrix) — one robust probe.
4. **Nothing runnable** (scratch/static image) → omit the healthcheck; out-of-band (5a) covers it.

**Build-time verification = the auto-heal:** after pulling the resolved image, run the candidate probe in a throwaway `docker run` and check for **exit 127/126 / "not found"** (a listen-probe on a not-yet-listening port returns 1 = fine; 127 = tooling missing). If the chosen probe would 127, fall to the next tier automatically — this is exactly what would have caught cliproxy's `wget` removal before it ever went unhealthy.

**Load-bearing guard (decision):** if a service that is a `service_healthy` dependency target reaches tier 4 (no runnable probe), **FAIL THE BUILD LOUDLY** — but with actionable remediation, not a bare error:
- name the service + the dependents that would hang;
- if the failure followed a version bump, print the **last-known-good version** (from the `_bak/` snapshot / prior `.generated.env` `*_IMAGE_REQUESTED`) and the exact revert command (`stack-cli update <svc> --to <old>` or the manual `*_VERSION=` edit);
- print how to declare a working `health.exec` override in `service.yaml`.

**Mechanism:** healthchecks move out of the static per-service `compose.yaml` into a build-generated override (e.g. `.stack/<svc>/healthcheck.gen.yaml` layered into the rendered compose, or written by `build.ts`), so the resolved probe is what runs. Services nobody waits on (cliproxy, agentgateway) may legitimately end at tier 4 (no compose healthcheck) and rely on out-of-band only.

## Implementation phases (this branch)

1. **P1 — Universal knobs** (`services.ts` owner-map + `serviceVersionKnobs` + `stack.ts` seeding). Tests in `scripts/test/`. No network. *Highest value, lowest risk — land first.*
2. **P2 — Version display** (`health.ts` field + enrich + `render-health.ts` column; `start` inherits via `runInfo`). Tests.
3. **P2.5 — Out-of-band health (5a)**: `service.yaml health:` schema + host-side probe; `info`/`start` show stack-derived health (not just Docker `(healthy)`). Foundation reused by the P4 gate. Tests (pure probe-spec resolution; probe with a stub server).
4. **P3 — Discovery adapters** (`version-sources/`) + **read-only `stack-cli update`**. Tests with mocked HTTP/`gh`.
5. **P4 — Targeted apply** (`commands/update.ts`: snapshot → resolve → **healthcheck auto-heal (5b)** → build → restart → out-of-band health-gate → rollback) + `update:` block + `<NAME>_UPDATE_CHANNEL`. The 5b resolution also runs at plain `build`. Tests incl. tier-selection + verify-runnable + load-bearing fail-loud-with-remediation.
6. **P5 — service.yaml cleanup**: move digest defaults to tags where sensible; drop redundant hand-declared `*_VERSION` env lines.

Deferred (not this branch): whole-stack `--latest`, hermes-VM `update`, agentmemory `update`.

## Testing

- Unit: owner-map registration for images/source knobs; `serviceVersionKnobs` for single/multi-image/source/none; `blockSync` seeding idempotency; channel precedence; version-string humanization (tag vs digest vs SHA); semver/date sort + channel-regex filter.
- Adapter tests with fixture payloads (no live network).
- Apply-pipeline test with a stubbed resolve/restart/health to assert snapshot + rollback-on-unhealthy.
- Healthcheck resolution: tier selection (image-HC present / `health.exec` / `/proc` fallback / none), the `$`-free `/proc` probe string, verify-runnable 127-detection, and the load-bearing fail-loud path emits last-known-good + revert command.
- Out-of-band probe-spec resolution (HTTP path/port defaults vs `tcp:`); probe against a local stub server.
- Reuse the existing `scripts/test/stack.test.ts` harness (`setup()` temp `.stack/.env`).

## Status (branch `feat/stack-cli-update`)

- **P1 universal knobs — DONE** (`07aca63`): `serviceVersionKnobs`/`serviceEnvSchema`, owner-map registration, seeding.
- **P2 version display — DONE** (`5f710c5`): `versions.ts`, `ServiceHealth.version`, render column.
- **P2.5 out-of-band health — DONE**: `service.yaml health:`, `health-probe.ts`, info/start `reachable` column.
- **P3 discovery + read-only update — DONE**: `version-sources.ts` (Docker Hub/GHCR/GitHub), `serviceTagKnobs` (plain-tag coverage), `stack-cli update [svc]`.
- **P4 apply + channel policy — DONE**: `commands/update.ts` apply pipeline (snapshot → bump → build → restart → out-of-band gate → rollback-with-remediation), `update:` block, `<SVC_UC>_UPDATE_CHANNEL`, `--to/--latest/--channel/--dry-run`. 87 tests green.
- **5b load-bearing healthcheck guard — DONE (bounded)**: `load-bearing.ts` (services depended on via `service_healthy`) + a warn in the apply path when a bumped load-bearing service is out-of-band reachable but Docker-unhealthy (broken probe → dependents hang), pointing at the compose-healthcheck fix / revert. Uses existing signals only.
- **5b auto-INJECTION — DEFERRED** (the part that swaps a broken probe for a generated `/proc` override). It sits on the compose/`dc` bring-up path (a malformed override breaks every `dc` command → stack won't start), so it needs a dedicated test cycle rather than shipping onto a live stack. The out-of-band gate + load-bearing warn already cover the runtime footgun.
- **P5 tag-pinning — DONE for litellm/honcho/honcho-ui** (`feat(services): tag-pin…`): litellm `v1.87.2` (release/stable channels), honcho `v3.0.9`, honcho-ui `v0.16.0`; GHCR adapter now paginates so big repos resolve. Apply with `stack-cli build && restart`.
- **P5a env-line cleanup — DONE** (branch `chore/p5-version-cleanup`): dropped the redundant hand-declared `PHOENIX_VERSION`/`AGENTGATEWAY_VERSION` env lines (auto-seeded from `images.default`); verified both still seed once + stay owned.
- **P5c digest→tag — NOT FEASIBLE as a no-op for the remaining digest services** (firecrawl ×3, hindsight, hermes-workspace; all DISABLED). Investigated 2026-06-12: firecrawl publishes NO version tags (only `latest`/`buildcache`/arch); hermes-workspace's pinned digest matches only the MOVING `main`/`latest` (no immutable version tag); hindsight's pinned digest matches none of its `0.0.x` tags. So a clean no-op conversion (à la litellm `v1.85.0`) is impossible — each would need an untested version bump. DECISION: leave digest-pinned; convert per-service WHEN ENABLED, verifying the new version live (the honcho-ui pattern). `update` correctly shows these as `digest-pinned — no channel` until then.

## Risks

- Owner-map change touches `stackGet`/`stackUpsert` for *all* keys — guard with tests; ensure no collision between an `images:` key and an existing `env:` key.
- Discovery flakiness/rate-limits (GH/registry) — adapters must fail soft (report "unknown", never block `info`).
- Seeding must never reorder/clobber existing user lines (rely on `blockSync` additive semantics; test).
- Healthcheck strings in compose are subject to `$`/`${}` interpolation — the `/proc` probe and any `health.exec` must be `$`-free or `$$`-escaped (test the rendered compose).
- A bumped substrate image (pg/redis/litellm) with a broken probe can hang every `service_healthy` dependent — the build-time verify + fail-loud guard (5b) is the backstop; never silently drop a load-bearing probe.
- Build-time `docker run` probe adds latency/needs the image pulled — gate it to images that reached tier 3, cache by digest.
