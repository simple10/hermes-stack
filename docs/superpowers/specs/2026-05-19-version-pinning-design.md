# Version Pinning & Build Strategy — design

Date: 2026-05-19
Status: implemented + post-implementation refactor. **Two-file model**: one
tracked `services/<svc>/service.env` (declares the service: deps, image
defaults, source defaults), one gitignored `.stack/<svc>/.generated.env`
(all build artifacts: secrets + resolved digests + source SHAs + rebuild
flag, all in one file via prefixed keys). The earlier `images.env` files
and per-service `.source.lock` / `.image.<NAME>.lock` / `.source.rebuild`
sidecars are gone — same information, fewer files. Inline `# tag …`
comments in service.env declarations MUST be stripped by readers (helper
`_env_value` in stacklib).

## Implemented model (authoritative — supersedes section details below)

The shipped design uses **two files per service**:

```
services/<svc>/service.env         # tracked — declares the service
.stack/<svc>/.generated.env        # gitignored — all build artifacts
```

**`services/<svc>/service.env`** holds the service's declarative contract:
- `SERVICE_REQUIRES=<comma profiles>` (cross-service deps; see deps-cleanup spec).
- `SERVICE_KIND=backend` for single-service substrate (pg/redis/rabbitmq).
- `<NAME>_IMAGE_REPO=…` + `<NAME>_IMAGE_DEFAULT=sha256:… # tag …`
  per digest-class image owned by this service. Multiple `<NAME>_*` pairs
  per service.env are supported (firecrawl has three).
- `<SVC_UC>_SOURCE_REPO=…` + `<SVC_UC>_SOURCE_DEFAULT=<sha> # tag …`
  for `_source`-class services.

Inline `# …` annotations on the value side are stripped by readers
(stacklib helper `_env_value`). Without stripping, the annotation would
leak into `git rev-parse` / `docker compose interpolation`, silently
producing the wrong commit / an invalid image ref. Regression-tested.

**`.stack/<svc>/.generated.env`** holds every build artifact in one file,
keys uniquely prefixed:
- secrets (existing): `<SVC_UC>_DB_PASSWORD`, `*_VIRTUAL_KEY`, etc.
- digest-class lock: `<NAME>_IMAGE_REQUESTED`,
  `<NAME>_IMAGE_RESOLVED_DIGEST`, `<NAME>_IMAGE` (the value compose reads).
- source-class lock: `<SVC_UC>_SOURCE_REQUESTED`,
  `<SVC_UC>_SOURCE_RESOLVED_SHA`, `<SVC_UC>_SOURCE_REBUILD` (set to `1` on
  change, cleared to empty by build.sh after a successful `dc build`).

`dc()`'s existing `--env-file .stack/*/.generated.env` glob picks the file
up for compose interpolation. Extra prefixed keys are inert (compose only
resolves `${VAR}` references that appear in compose files).

**Helpers** (`lib/stacklib.sh`):
- `stack_source SVC [REPO DEFAULT_PIN]` — REPO/DEFAULT_PIN default to
  `<SVC_UC>_SOURCE_REPO`/`_SOURCE_DEFAULT` in service.env.
- `stack_image NAME REPO DEFAULT_PIN [SVC]` — same shape as before.
- `stack_resolve_images` — scans `services/*/service.env` for
  `<NAME>_IMAGE_REPO` keys (was: `services/*/images.env`).
- `_env_value FILE KEY` — `env_get` + strip inline `# …` comment + trim
  whitespace. Used for all declarative reads from service.env.
- `ensure_dockerignore SRC_DIR` — append-if-absent `.git/` line.

Build.sh callers collapse to one-liners (no inline pin args):
```bash
stack_source honcho
GEN="$STACK_DIR/honcho/.generated.env"
if [ -n "$(env_get "$GEN" HONCHO_SOURCE_REBUILD)" ]; then
  dc build honcho-api honcho-deriver
  env_upsert "$GEN" HONCHO_SOURCE_REBUILD ""
fi
```

The legacy sections below (file layout under `_source`/`.image-digest`,
`stack_image NAME REPO ...` lock-file paragraph, "declarative `images.env`"
section, etc.) describe the pre-refactor design and remain for historical
context — defer to this section on any conflict.

## Problem

The current pinning/build strategy has three problems:

1. **Opaque pins.** Every `_source` service hardcodes a full commit SHA
   (`HONCHO_PIN="8fcbb54a…"`) with no annotation of which upstream release/tag
   it corresponds to. Reading or bumping a pin requires going to GitHub and
   resolving the SHA to a human version. Tracked image digests
   (`@sha256:7bb805…`) have the same problem.
2. **Duplicated, drift-prone clone/checkout/pin logic.** Each `_source`
   build.sh (`honcho`, `honcho-ui`, `camofox-browser`, `browser-use`) repeats
   the same clone → checkout → `rm -rf _source/.git` block — slightly
   inconsistently (e.g. `rm -rf "$D/_source"` is in 3/4, missing in 1).
3. **No user-friendly bump path.** Users cannot override a version from
   `.stack/.env`; bumping requires editing a build script and (for digest-
   pinned images) hand-resolving a tag to a digest. The only existing
   counter-example is `cliproxyapi`'s `${CLIPROXY_VERSION:-v7.1.11}`.

`.git` removal is a real but solvable concern (Docker build context size) —
it can be retained with a tiny `.dockerignore`, gaining provenance/
`git describe`/cheap bumping without bloating builds.

## Goals

- One **`<SVC>_VERSION` lever** in `.stack/.env` per externally-sourced
  service: a **tag or a SHA/digest**. Empty = use the tracked default.
- Tracked defaults stay **immutable** (commit SHA / image digest) **and
  legible** (annotated with their human tag in a code comment).
- **One stacklib helper** per kind (source, image) — no clone/resolve/lock
  code duplicated in any build.sh.
- A bump = edit one line in `.stack/.env` + `just build` — auto-detected,
  re-resolved, image rebuilt/repulled, lock updated. Reproducible across
  fresh checkouts (defaults are the tracked source of truth).
- **Non-destructive migration**: every default resolves to the *exact* pin
  currently in use; no image/source changes unless the user opts to bump.

## Non-goals

- No change to which images/sources are used by default (no upstream bumps
  baked into this refactor).
- No supply-chain verification (signatures, SBOM). Out of scope.
- No tag-to-digest resolution for the **tag class** of images. We accept
  small drift on well-curated public registries (Docker Hub `redis`/`pg`/
  `rabbitmq` and `eceasy/cli-proxy-api`) per explicit user direction.
- No CI/automation for periodic version refresh. Out of scope.
- `agentmemory`'s three Dockerfile build args (`AGENTMEMORY_VERSION`,
  `III_VERSION`, `III_SDK_VERSION`) are **out of scope**. They pin npm
  releases via `args:`, not git/image refs; a different machinery (compose
  arg interpolation per build) and a separate spec.

---

## Design A — `lib/stacklib.sh` helpers

Two new helpers eliminate per-service duplication. Both follow a uniform
`requested → resolved` pattern, write a per-service lock under
`.stack/<svc>/`, and are change-detecting.

### `_svc_uc NAME` — internal

`browser-use` → `BROWSER_USE`, `honcho-ui` → `HONCHO_UI`,
`camofox-browser` → `CAMOFOX_BROWSER`. Hyphens → underscores; uppercase.
Used only inside the helpers (`stack_source` / `stack_image`) to derive
`<SVC_UC>_VERSION` / `<SVC_UC>_IMAGE` env var names. Tag-class images do
not go through the helpers, so their compose env-var names are chosen
freely (notably `CLIPROXY_VERSION` — the existing grandfathered name —
rather than `CLIPROXYAPI_VERSION` the rule would otherwise produce).

### `stack_source SVC REPO DEFAULT_PIN`

Idempotent fetch + checkout of `services/<svc>/_source/` to a pinned commit.
Default arg is the **tracked annotated default** (SHA, with a `# tag X`
comment on the call site).

**Algorithm (failure-mode-explicit):**
```
requested = ${<SVC_UC>_VERSION:-<DEFAULT_PIN>}
lock      = .stack/<svc>/.source.lock         # KV: requested=…\nresolved_sha=…
src       = services/<svc>/_source

# --- defensive identity check on existing _source ---
if [ -d src/.git ]:
  origin_url = git -C src remote get-url origin || ""
  if origin_url != REPO:
    die "stack_source: $src origin '$origin_url' != expected '$REPO' (re-clone manually if intended)"

# --- reuse fast path (offline, no rebuild marker) ---
if [ -d src/.git ] && [ -f lock ]:
  read lock.requested lock.resolved_sha
  if lock.requested == requested
     and (git -C src rev-parse HEAD) == lock.resolved_sha:
    ensure_dockerignore "$src"      # idempotent; see below
    return

# --- fetch path ---
if [ ! -d src/.git ]:
  rm -rf src
  git clone REPO src                # full clone; we keep .git

# Resolve requested (tag, SHA, or branch). Try local first; on fail, fetch
# the ref explicitly (handles arbitrary SHAs on non-default branches via
# GitHub's allowReachableSHA1InWant, and branches not yet tracked).
git -C src fetch --tags origin
sha = $(git -C src rev-parse "${requested}^{commit}" 2>/dev/null) || true
if [ -z "$sha" ]:
  git -C src fetch origin "$requested" 2>/dev/null || true
  sha = $(git -C src rev-parse "${requested}^{commit}" 2>/dev/null) \
     || sha = $(git -C src rev-parse "origin/${requested}^{commit}" 2>/dev/null) \
     || sha = $(git -C src rev-parse "FETCH_HEAD^{commit}" 2>/dev/null) \
     || die "stack_source: cannot resolve '$requested' in $REPO"

git -C src checkout --detach "$sha"     # fails if working tree dirty — by design
ensure_dockerignore "$src"

mkdir -p .stack/<svc>
write lock "requested=${requested}\nresolved_sha=${sha}\n"
touch .stack/<svc>/.source.rebuild      # marker the caller checks
```

`ensure_dockerignore SRC` is a tiny helper: if `SRC/.dockerignore` is
missing, create it containing `.git/`; if it exists, append `.git/` only if
that exact line isn't already present (so upstream `.dockerignore`s — e.g.
honcho's — are preserved, not clobbered).

Caller (build.sh) checks `.source.rebuild`, runs `dc build <service>` if
present, then `rm -f .source.rebuild`. (No marker = no image rebuild needed
— pure reuse path.)

**`.git` retention + build-context hygiene.** `.git/` stays in `_source/`
for provenance/`git describe`/cheap bumps. Two cases by `build.context`:

- **`context: ./_source`** (honcho api+deriver+schema, camofox-browser,
  browser-use): Docker reads `.dockerignore` from `_source/`. The
  `ensure_dockerignore` step above appends `.git/` (preserving upstream
  excludes like honcho's 14-line file).
- **`context: .`** (honcho-ui — Dockerfile does `COPY _source/ ./`): the
  build-context root is `services/honcho-ui/`. A tracked
  `services/honcho-ui/.dockerignore` containing `_source/.git/` is required
  (the `_source/.dockerignore` is *not* read in this case). One-line file,
  tracked. Only honcho-ui needs this today (agentmemory has `context: .`
  but does not `COPY _source/`, so no `.git` ever ships).

### `stack_image NAME REPO DEFAULT_PIN [SVC]`

For the **digest class** only. Resolves `<NAME>_VERSION` (tag or digest)
to a concrete digest and writes `<NAME>_IMAGE` into a per-service
generated env that `dc()` already globs.

- `NAME` is the **compose service name, UPPERCASED with hyphens→underscores**
  (`LITELLM`, `FIRECRAWL_API`, `FIRECRAWL_PLAYWRIGHT`, `FIRECRAWL_POSTGRES`,
  `HINDSIGHT`). Used as-is in the user-facing var names (`<NAME>_VERSION` /
  `<NAME>_IMAGE`), in the per-image lock filename (`.image.<NAME>.lock`),
  and as the key in `images.env`. No additional case transform anywhere.
- `SVC` defaults to `NAME` (single-image services). For multi-image services
  (firecrawl owns three compose services), `SVC=firecrawl` and `NAME`
  varies — all three locks/env-vars live under `.stack/firecrawl/`,
  preserving the "service dir == `.stack/<svc>/`" invariant from the
  deps-cleanup spec.

**Algorithm:**
```
requested = ${<NAME>_VERSION:-<DEFAULT_PIN>}    # "sha256:…" or a tag
lock      = .stack/<SVC>/.image.<NAME>.lock        # per-image
genenv    = .stack/<SVC>/.generated.env

case requested in
  sha256:*)  digest=$requested ;;
  *)         digest=$(docker buildx imagetools inspect "${REPO}:${requested}" \
                      --format '{{.Manifest.Digest}}') \
               || die "stack_image: 'docker buildx imagetools inspect ${REPO}:${requested}' failed (network/auth/unknown tag)"
             [ -n "$digest" ] || die "stack_image: empty digest for ${REPO}:${requested}"
             ;;
esac

if [ -f lock ] and lock.requested == requested and lock.resolved_digest == digest:
  : # no change
else:
  mkdir -p "$(dirname "$lock")"
  write lock "requested=${requested}\nresolved_digest=${digest}\n"

# Always (re-)write the env var so dc() interpolation works after fresh
# checkout. env_upsert is atomic per-key, so multi-image SVCs are safe.
env_upsert "$genenv" "<NAME>_IMAGE" "${REPO}@${digest}"
```

**Failure-mode note:** capturing `$(…)` exit code outside a `local` assignment
is critical — `local digest=$(…)` swallows the rc under `set -e`. Use bare
assignment + `|| die`. Single-line `set -e`-safe assignment also fine:
`digest=$(…) || die …`.

Compose reads `image: ${<NAME>_IMAGE:?run 'just build' to resolve <NAME>_VERSION}`.
The `:?` form fails loudly with that exact message if the env var is unset
— making the build-first dependency explicit on fresh checkouts.

> Why the spec doesn't have `stack_image` called from `build.sh`:
> compose `include:` interpolates **every** included file on every `dc`
> invocation, so `${<NAME>_IMAGE:?…}` blocks every `dc` call until *all*
> digest-class images are resolved — regardless of which profiles are
> active. Profile-gated resolution is therefore architecturally wrong.
> Resolution runs from a central, unconditional phase in `just build`; see
> Design D.

### Tests

Both helpers get fixture-driven test cases in `lib/stacklib.test.sh`:
- `stack_source`: tag→sha resolution, SHA pass-through (including a SHA on
  a non-default branch — covers the `git fetch origin <sha>` fallback),
  change detection (lock differs ⇒ rebuild marker), reuse path (no network,
  no marker), unknown ref fails loud, origin-URL mismatch fails loud,
  upstream `.dockerignore` preserved + `.git/` appended once (idempotent).
- `stack_image`: digest pass-through, tag→digest resolution (mocked via a
  fake `docker` shim in `PATH` for hermetic CI), change detection, fail-loud
  on bad ref, multi-image co-residence (3 calls under the same `SVC` write
  3 distinct env vars + 3 lock files in one `.stack/<svc>/`).

A fake-`docker` shim avoids hitting the real network/registry in tests.

---

## Design B — `_source` services

Affected: `honcho`, `honcho-ui`, `camofox-browser`, `browser-use`.

Each `build.sh` collapses its clone/checkout/pin block to one call:

```bash
# honcho/build.sh (excerpt)
stack_source honcho https://github.com/plastic-labs/honcho \
  8fcbb54a49292341dba79d606ee332c50778429b   # tag <ANNOTATE-ON-BUMP>

if [ -f "$STACK_DIR/honcho/.source.rebuild" ]; then
  dc build honcho-api honcho-deriver
  rm -f "$STACK_DIR/honcho/.source.rebuild"
fi
```

The `# tag …` annotation is the legibility fix — every committed default
carries its human version next to it. For pins that don't correspond to a
release tag (commit-on-main snapshots), the annotation is a date or branch
(e.g. `# main@2026-05-15`). Honest, never empty.

**Tag annotations are written during implementation, not deferred.** The
implementation step researches the upstream tag each current pin
corresponds to (`git -C _source describe --tags --always <sha>` after
`stack_source`) and embeds it in the call-site comment. `.stack.env.example`
example values must match these annotations exactly so users see a
no-op-equivalent bump on first try.

**`.dockerignore` handling** depends on `build.context` (verified per
compose):

| Service | `build.context` | `.dockerignore` strategy |
|---|---|---|
| honcho api+deriver+schema | `./_source` | `stack_source` appends `.git/` to `_source/.dockerignore` (preserves honcho's upstream 14-line file). |
| camofox-browser | `./_source` | same. |
| browser-use | `./_source` | same. |
| **honcho-ui** | `.` (parent dir) — Dockerfile `COPY _source/ ./` | **Tracked** `services/honcho-ui/.dockerignore` containing `_source/.git/` (one line, one tracked file). `_source/.dockerignore` is NOT consulted by Docker when context is the parent. |

`agentmemory` has `context: .` but does not `COPY _source/`; no `.git`
ships, so no `.dockerignore` change needed.

---

## Design C — image services (two-tier)

**Classification rule:** images from `ghcr.io` → **digest class** (CI-built,
weaker tag curation; we want digest immutability). Images from other
registries (Docker Hub `library/*`, `pgvector/*`, `eceasy/*`) → **tag class**
(curated upstream tags; small drift acceptable).

### Tag class — compose interpolation only

No build-time resolver. The compose `image:` line uses the lever directly
with a tracked default tag. **All four `pgvector/pgvector:pg18` occurrences
get interpolated** so `PG_VERSION` is a single coherent lever:

| Compose file (line) | `image:` (new) |
|---|---|
| `services/pg/compose.yaml` | `pgvector/pgvector:${PG_VERSION:-pg18}` |
| `services/honcho/compose.yaml` (honcho-provision) | `pgvector/pgvector:${PG_VERSION:-pg18}` |
| `services/litellm/compose.yaml` (litellm-provision) | `pgvector/pgvector:${PG_VERSION:-pg18}` |
| `services/hindsight/compose.yaml` (hindsight-provision) | `pgvector/pgvector:${PG_VERSION:-pg18}` |
| `services/redis/compose.yaml` | `redis:${REDIS_VERSION:-8.6.3}` |
| `services/rabbitmq/compose.yaml` | `rabbitmq:${RABBITMQ_VERSION:-4.3.0-management}` |
| `services/cliproxyapi/compose.yaml` | already `eceasy/cli-proxy-api:${CLIPROXY_VERSION:-v7.1.11}` — **no change** (existing precedent). |

`CLIPROXY_VERSION` keeps its existing name (grandfathered).

### Digest class — declarative `images.env` + central resolver

**Architecture constraint.** `docker-compose.yaml` `include:`s every
service compose. Compose v5 interpolates **every** included file on every
`dc` invocation, so `${X:?…}` anywhere in the tree blocks every `dc` call
until `X` is set. Image resolution must therefore run **unconditionally**
(for every digest-class image, regardless of which profiles are active) —
not from per-profile `build.sh` files.

**Declarative manifest.** Each service that owns one or more digest-class
images ships a tracked `services/<svc>/images.env`. One image per
non-comment line, format: `NAME=REPO@DEFAULT_PIN  # tag <annotate>`.

| File | Lines |
|---|---|
| `services/litellm/images.env` | `LITELLM=ghcr.io/berriai/litellm-database@sha256:7bb80500…  # tag <annotate>` |
| `services/hindsight/images.env` | `HINDSIGHT=ghcr.io/vectorize-io/hindsight@sha256:…  # tag <annotate>` |
| `services/firecrawl/images.env` | `FIRECRAWL_API=ghcr.io/firecrawl/firecrawl@sha256:fb156ea5…  # tag <annotate>` <br> `FIRECRAWL_PLAYWRIGHT=ghcr.io/firecrawl/playwright-service@sha256:9e07…  # tag <annotate>` <br> `FIRECRAWL_POSTGRES=ghcr.io/firecrawl/nuq-postgres@sha256:f9388bd2…  # tag <annotate>` |

`NAME` MUST equal the compose service name (uppercased, hyphens→underscores)
so `<NAME>_VERSION` / `<NAME>_IMAGE` are intuitive. firecrawl's three
compose services (`firecrawl-api`, `firecrawl-playwright`,
`firecrawl-postgres`) → `FIRECRAWL_API`, `FIRECRAWL_PLAYWRIGHT`,
`FIRECRAWL_POSTGRES`.

**Compose lines** become:

| Compose service | `image:` (new) |
|---|---|
| `litellm` | `image: "${LITELLM_IMAGE:?run 'just build' to resolve LITELLM_VERSION}"` |
| `hindsight` | `image: "${HINDSIGHT_IMAGE:?run 'just build' to resolve HINDSIGHT_VERSION}"` |
| `firecrawl-api` | `image: "${FIRECRAWL_API_IMAGE:?run 'just build' to resolve FIRECRAWL_API_VERSION}"` |
| `firecrawl-playwright` | `image: "${FIRECRAWL_PLAYWRIGHT_IMAGE:?run 'just build' to resolve FIRECRAWL_PLAYWRIGHT_VERSION}"` |
| `firecrawl-postgres` | `image: "${FIRECRAWL_POSTGRES_IMAGE:?run 'just build' to resolve FIRECRAWL_POSTGRES_VERSION}"` |

**YAML quoting is mandatory.** The whole scalar MUST be **double-quoted**
(as shown above) — `${VAR:?…}` containing embedded single-quotes and
spaces is brittle as an unquoted YAML scalar; Compose's YAML loader expects
double-quoted form for interpolation values with special characters.

**Resolution is centralized in `just build`** (see Design D); per-service
`build.sh` files do not call `stack_image`. The resolver parses every
`services/*/images.env` and calls `stack_image NAME REPO DEFAULT_PIN <svc>`
for each line — runs even for services whose profile is inactive, because
the compose `${…:?}` references are global.

**`.image-digest` sidecar files** (currently in `services/{litellm,firecrawl,
hindsight}/`) become redundant — the digest now lives in `images.env` (the
tracked default + comment) and in `.stack/<svc>/.image.<NAME>.lock`. Delete
the sidecars; also update the in-compose comments that referenced them
(`services/{litellm,firecrawl,hindsight}/compose.yaml` line 4).

---

## Design D — `just build` orchestration

`justfile`'s `build:` recipe is restructured into two explicit phases:

**Phase 1 (always-run): image resolution.** Iterate every
`services/*/images.env` and call `stack_image NAME REPO DEFAULT <svc>` per
line. This populates every `<NAME>_IMAGE` in
`.stack/<svc>/.generated.env`, satisfying compose's global
`${…_IMAGE:?…}` references — regardless of `COMPOSE_PROFILES`. Cheap on the
reuse path (digest already pinned, no override → no network).

Implementation sketch in `lib/stacklib.sh`:
```bash
# stack_resolve_images — invoked from `just build` (and defensively from `start`).
stack_resolve_images() {
  local f svc name rest repo_pin repo default
  for f in "$STACK_ROOT"/services/*/images.env; do
    [ -e "$f" ] || continue
    svc="$(basename "$(dirname "$f")")"
    while IFS='=' read -r name rest; do
      # strip CR (Windows line endings); skip blank + comment-only lines
      name="${name%$'\r'}"; name="${name##[[:space:]]}"; [ -z "$name" ] && continue
      case "$name" in '#'*) continue;; esac
      # right-trim rest of any trailing whitespace + optional "# tag …" comment,
      # then split on '@'. `read -r` gives one-shot whitespace tokenization.
      repo_pin="${rest%%#*}"                                  # drop inline comment
      read -r repo_pin <<<"$repo_pin"                         # trim leading/trailing WS
      repo="${repo_pin%@*}"; default="${repo_pin#*@}"
      [ -n "$repo" ] && [ -n "$default" ] \
        || die "stack_resolve_images: malformed line in $f: $name=$rest"
      stack_image "$name" "$repo" "$default" "$svc"
    done < "$f"
  done
}
```
(Spec specifies behavior + the exact trim/split idiom; plan will add fixture
tests covering trailing whitespace, CRLF, inline comments, blank lines.)

**Phase 2: per-profile build.sh loop, iterating `stack_profiles`** (not the
raw `COMPOSE_PROFILES`). Today `justfile:build` loops the raw value — that
skips transitive deps (e.g. `COMPOSE_PROFILES=honcho` does NOT run
`litellm/build.sh`, even though honcho requires litellm). Switching to
`stack_profiles` runs every transitive build.sh. (The existing explicit
`services/pg/build.sh` invocation remains — pg is always required by any
real stack and writes `POSTGRES_SUPERPASS`; running it unconditionally is
correct.) Phase-2 build.shs do password ownership, source clone+checkout
(via `stack_source`), eager `dc build` for source services. They do NOT
resolve images (Phase 1 handles that, unconditionally).

**`just build` order:**
1. `stack_resolve_images` (Phase 1) — runs FIRST so any subsequent step
   that invokes `dc` (including pg's build.sh if it grows to) has all
   `<NAME>_IMAGE` env vars resolved. Cheap on the reuse path; fail-fast
   on registry/network problems before anything mutates state.
2. `services/pg/build.sh` (unchanged explicit invocation — superpass owner).
3. For `p` in `stack_profiles | tr ',' ' '`: `services/$p/build.sh` if
   executable (Phase 2). `stack_profiles` returns a COMMA-separated string
   (see lib/stacklib.sh); the justfile uses the same `tr ',' ' '` pattern
   already in use for `COMPOSE_PROFILES`.
4. For `m` in `STACK_MACHINES`: `machines/$m/build.sh` (unchanged).

Phase ordering matters: Phase 1 must precede every other step that invokes
`dc`, because compose `include:` parses the full tree on every invocation
and `${<NAME>_IMAGE:?…}` blocks if unresolved.

## Design E — `.stack/.env` conventions + ergonomics

New documented block in `.stack.env.example`:

```sh
# === Service versions (all OPTIONAL; defaults are the tracked annotated pins).
# Tag class — accepts an upstream tag. Pulled as-is (small drift accepted):
#   PG_VERSION=pg18                    REDIS_VERSION=8.6.3
#   RABBITMQ_VERSION=4.3.0-management  CLIPROXY_VERSION=v7.1.11
# Digest class — accepts a tag (resolved to digest) OR a sha256 digest:
#   LITELLM_VERSION=v1.78.6            HINDSIGHT_VERSION=…
#   FIRECRAWL_API_VERSION=…  FIRECRAWL_PLAYWRIGHT_VERSION=…  FIRECRAWL_POSTGRES_VERSION=…
# Source class — accepts a tag OR a commit SHA (fetched, checked out, image rebuilt):
#   HONCHO_VERSION=…   HONCHO_UI_VERSION=…
#   CAMOFOX_BROWSER_VERSION=…   BROWSER_USE_VERSION=v0.12.7
```

### Bump UX

```bash
$EDITOR .stack/.env                           # add or change <SVC>_VERSION
just build                                     # auto-detects, re-resolves, rebuilds if needed
just up                                        # recreate picks up the new image
```

For source bumps, `stack_source` resolves the new ref, checks out the SHA,
writes `.source.rebuild`, build.sh runs `dc build`. For digest-class image
bumps, `stack_image` resolves to a new digest, writes the new `<SVC>_IMAGE`
into `.stack/<svc>/.generated.env`, `dc up -d` recreates the container on
the new digest. For tag-class image bumps, `dc up -d` (with `--pull always`
is NOT the default — see Risk) pulls only if the local cache misses the
tag's image; users can `dc pull <svc>` if they want to ensure latest.

### Storage layout (consistent with the new `.stack/<svc>/` architecture)

```
.stack/<svc>/
  .source.lock              # source class — requested + resolved_sha
  .image.<NAME>.lock        # one per digest-class image (multi-image services have multiple)
  .source.rebuild           # transient marker; build.sh removes after dc build
  .generated.env            # already exists; gains <NAME>_IMAGE entries (multi-image safe via env_upsert)
```

All gitignored (under `.stack/`). The tracked source of truth for
reproducibility is `services/<svc>/images.env` (digest class) and the
annotated default arg in `build.sh` (source class).

---

## Migration

The refactor is **non-destructive by construction**: every tracked default
equals the exact pin in use today.

1. Land helpers + `stack_resolve_images` in `lib/stacklib.sh`; tests in
   `lib/stacklib.test.sh`.
2. Update `justfile:build` to: (a) call `stack_resolve_images` after
   `services/pg/build.sh`; (b) loop `stack_profiles` (expanded) instead of
   raw `COMPOSE_PROFILES` for the per-profile build.sh phase.
3. Convert 4 `_source` `build.sh` files to use `stack_source` (no
   `stack_image` calls — image resolution is centralized now). For
   honcho-ui, add a tracked `services/honcho-ui/.dockerignore` containing
   `_source/.git/`. `_source` dirs already exist on live stacks — the
   first `stack_source` against them: `.git` absent → re-clone (preserves
   the pinned content; image layer cache holds since explicit-COPY
   Dockerfiles don't hash on context-level ignored files).
4. Convert **6** tag-class `image:` lines (`pg` + 3 provisioners' pgvector +
   `redis` + `rabbitmq`). cliproxyapi (1 line) already uses the pattern;
   total tag-class footprint after refactor = 7 lines. Default tag = current
   value. `dc up -d` is a no-op (same image).
5. Create three `services/<svc>/images.env` files (`litellm`, `hindsight`,
   `firecrawl`) with the current digests as `DEFAULT_PIN` and `# tag …`
   annotations researched at implementation time.
6. Convert 5 digest-class `image:` lines in compose to the **double-
   quoted** form `image: "${<NAME>_IMAGE:?run 'just build' to resolve
   <NAME>_VERSION}"` (mandatory YAML quoting — see Design C).
7. Delete `services/{litellm,firecrawl,hindsight}/.image-digest` sidecars
   AND update the in-compose comments at line 4 of each that reference
   them.
8. Update `.stack.env.example` with the version block (all lever names,
   matched against the annotated defaults so example values are no-ops).
9. Update README pinning section (current behavior description is stale —
   "deps auto-pulled" wording + digest-pin description).

Live-stack ordering: `just build` (Phase 1 resolves all digests, writes
`<NAME>_IMAGE` env files; Phase 2 may re-clone existing `_source`s with
`.git` — same pinned content) → `dc up -d` is a no-op on unchanged pins.
No volume or container touched unless the user has set a `<NAME>_VERSION`
override.

---

## Acceptance criteria

1. `lib/stacklib.sh` provides `stack_source`, `stack_image`, and
   `stack_resolve_images`; fixture tests in `lib/stacklib.test.sh` cover:
   `stack_source` tag-resolve, SHA pass-through (including non-default-
   branch SHA via fetch-fallback), origin-URL-mismatch fails loud,
   `.dockerignore` append-if-absent (preserves upstream content), reuse
   (no network) / change detection; `stack_image` digest pass-through,
   tag→digest via mocked `docker` shim, exit-code propagation on resolver
   failure, multi-image co-residence in one `.stack/<svc>/`;
   `stack_resolve_images` discovers all `services/*/images.env` and
   invokes `stack_image` per line. Tests pass with no real network.
2. Every `_source` `build.sh` calls `stack_source` and contains **no**
   `git clone`/`checkout`/`rm -rf .git`/`stack_image` lines. For
   `context: ./_source` services, `_source/.dockerignore` exists post-
   build with `.git/` present (appended-if-absent — honcho's upstream
   14-line file is intact). For honcho-ui (`context: .`), tracked
   `services/honcho-ui/.dockerignore` exists with `_source/.git/`.
3. `_source` dirs retain `.git` after a fresh `just build`
   (`git -C services/<svc>/_source rev-parse HEAD` succeeds; equals
   `.stack/<svc>/.source.lock`'s `resolved_sha`).
4. **All four `pgvector/pgvector` references interpolated**:
   `grep -rn 'pgvector/pgvector' services/*/compose.yaml` returns lines
   that all use `${PG_VERSION:-pg18}`. Same coherence for `redis` (1) and
   `rabbitmq` (1). Tag-class images use compose
   `${<NAME>_VERSION:-<default-tag>}`; digest-class images use
   `${<NAME>_IMAGE:?…}` with `<NAME>_IMAGE` populated by
   `stack_resolve_images`.
5. **`justfile:build` runs in two explicit phases**: Phase 1
   (`stack_resolve_images`) before Phase 2 (per-profile build.sh loop over
   `stack_profiles | tr ',' ' '`). With `COMPOSE_PROFILES=cliproxyapi` (no
   litellm/hindsight/firecrawl active), `just build` still populates
   `LITELLM_IMAGE`, `HINDSIGHT_IMAGE`, **all three of** `FIRECRAWL_API_IMAGE`,
   `FIRECRAWL_PLAYWRIGHT_IMAGE`, `FIRECRAWL_POSTGRES_IMAGE` in their
   respective `.stack/<svc>/.generated.env`, so `dc up -d cliproxyapi`
   succeeds (proves B1 + B2 closed).
6. **Non-destructive default round-trip**: on the live stack, after the
   refactor, `just build` followed by `dc up -d` recreates **zero**
   containers (all resolved digests/tags match the pre-refactor state).
7. **Bump round-trip.** For images whose default has a matching upstream
   tag annotation (e.g. `# tag v1.78.6`), setting
   `LITELLM_VERSION=v1.78.6` re-resolves to the same digest the default
   produces; lock updated, container not recreated. For images whose
   annotation is a date/branch (`# main@2026-05-18` — upstream ships no
   matching tag), the round-trip is exercised by setting
   `LITELLM_VERSION=<the resolved digest from .stack/litellm/.image.LITELLM.lock>`
   instead; same outcome.
8. `services/{litellm,firecrawl,hindsight}/.image-digest` removed AND the
   three in-compose comments referencing them (line 4 of each) updated.
9. `.stack.env.example` documents every lever (one comment line per
   `<NAME>_VERSION`) with the bump-pattern shown for each class
   (tag/digest/source). README pinning section updated.

## Risks

- **Tag class accepts upstream drift.** A maintainer of `redis:8.6.3` could
  re-tag (uncommon for Docker Official Images but possible). Mitigation:
  this is the explicitly accepted tradeoff for ergonomics; digest class
  exists for images where it isn't acceptable. The full classification rule
  is `ghcr.io → digest` and is auditable.
- **`docker buildx imagetools inspect` is the resolver dependency.**
  Requires Docker 20.10+ with buildx (OrbStack ships this; the project
  already uses `dc build`/`buildx`). Mitigation: `stack_image` fails loud
  with a clear message (and explicit exit-code propagation — `set -e`
  doesn't catch failures inside `local x=$(…)`).
- **Fresh-checkout dependency on `just build` before `dc up -d`.** Compose
  `${LITELLM_IMAGE:?…}` errors loudly if Phase 1 hasn't run. By design.
  README/quickstart already prescribes `setup → build → start`.
- **First-time `stack_source` against existing `_source` re-clones.**
  Existing live stacks have `.git`-less `_source` from the old pattern;
  first `stack_source` triggers a re-clone (`if [ ! -d src/.git ]`).
  One-time per stack; same pinned SHA → same source bytes → image layer
  cache holds (explicit-COPY Dockerfiles).
- **Lock-vs-default drift on a fresh checkout.** Fresh clones have no
  `.stack/<svc>/.source.lock` / no `<NAME>_IMAGE` env. First `just build`
  resolves defaults → checks out / writes env. Reproducible: tracked
  defaults (`images.env` + `build.sh` annotated arg) are the source of
  truth; locks are change-detection caches.
- **Cross-profile compose `include:` couples digest resolution.** Compose
  v5 interpolates every included file on every `dc` invocation, so a
  digest-class service must have its `<NAME>_IMAGE` resolved even when its
  profile is inactive. This is exactly why resolution is in Phase 1
  (unconditional) — but it means any new digest-class image MUST add an
  entry to `services/<svc>/images.env`; otherwise `dc` will block stack-
  wide. Mitigation: acceptance #5 exercises an inactive-profile bringup.
- **Concurrent-agent build races.** Two simultaneous `just build`s could
  race on `services/<svc>/_source/` (git operations) and lock files.
  `env_upsert` is atomic per-file (mktemp+mv) but `git clone`/`checkout`
  isn't. **Out of scope for this spec** (project memory documents single-
  agent build discipline); if it becomes a problem, add `flock` around
  `stack_source`/`stack_image` per-service.
