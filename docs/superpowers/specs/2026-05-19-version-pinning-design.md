# Version Pinning & Build Strategy — design

Date: 2026-05-19
Status: approved; dual self-reviewed 2026-05-19 (fixed: `.dockerignore`
context-root location; clarified `_svc_uc` scope vs grandfathered names)

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

**Algorithm:**
```
requested = ${<SVC_UC>_VERSION:-<DEFAULT_PIN>}
lock      = .stack/<svc>/.source.lock         # KV: requested=…\nresolved_sha=…
src       = services/<svc>/_source

if [ -d src/.git ] && [ -f lock ]:
  read lock.requested lock.resolved_sha
  if lock.requested == requested
     and (git -C src rev-parse HEAD) == lock.resolved_sha:
    return  # reuse, no network, no rebuild marker

if [ ! -d src/.git ]:
  # fresh clone (full default-branch clone; we keep .git)
  rm -rf src
  git clone REPO src

# fetch the requested ref (tag or SHA; --tags ensures release tags are present)
git -C src fetch --tags origin
sha = git -C src rev-parse "${requested}^{commit}"   # fails loud on unknown ref
git -C src checkout --detach "$sha"

mkdir -p .stack/<svc>
write lock "requested=${requested}\nresolved_sha=${sha}\n"
touch .stack/<svc>/.source.rebuild              # marker the caller checks
```

Caller (build.sh) checks `.source.rebuild`, runs `dc build <service>` if
present, then `rm -f .source.rebuild`. (No marker = no image rebuild needed
— pure reuse path.)

**`.git` retention + build-context hygiene.** `.git/` is kept in `_source/`
for provenance/`git describe`/cheap bumps. Docker reads `.dockerignore` from
the **build context root** (`_source/`, per each compose's
`build.context: ./_source`), not from `services/<svc>/`. So `stack_source`
writes `_source/.dockerignore` (with `.git/` on its own line) after
checkout. The file lives in the gitignored `_source/` dir — no new tracked
files; it is regenerated/maintained on every `stack_source` call. The
Docker build context excludes `.git/` even though the working tree keeps
it.

### `stack_image SVC REPO DEFAULT_PIN`

For the **digest class** only. Resolves `<SVC_UC>_VERSION` (tag or digest) to
a concrete digest and writes `<SVC_UC>_IMAGE` into the service's per-service
generated env, which `dc()` already globs.

**Algorithm:**
```
requested = ${<SVC_UC>_VERSION:-<DEFAULT_PIN>}    # e.g. "sha256:7bb…" or "v1.78.6"
lock      = .stack/<svc>/.image.lock              # KV: requested=…\nresolved_digest=…
genenv    = .stack/<svc>/.generated.env

case requested in
  sha256:*)  digest=$requested ;;                 # already a digest, use as-is
  *)         # tag (or branch); resolve via the local docker daemon
             digest="$(docker buildx imagetools inspect "${REPO}:${requested}" \
                        --format '{{.Manifest.Digest}}')"
             [ -n "$digest" ] || die "stack_image: failed to resolve ${REPO}:${requested}"
             ;;
esac

if [ -f lock ] and lock.requested == requested and lock.resolved_digest == digest:
  : # no change; lock current
else:
  mkdir -p .stack/<svc>
  write lock "requested=${requested}\nresolved_digest=${digest}\n"

# always (re-)write the env var into the per-service generated env so dc()
# interpolation sees the resolved image even on fresh checkouts.
env_upsert "$genenv" "<SVC_UC>_IMAGE" "${REPO}@${digest}"
```

Compose reads `image: ${<SVC_UC>_IMAGE:?run "just build" to resolve <SVC_UC>_VERSION}`.
The `:?` form fails loudly with that exact message if `just build` has not
been run on a fresh checkout — making the dependency explicit.

### Tests

Both helpers get fixture-driven test cases in `lib/stacklib.test.sh`:
- `stack_source`: tag→sha resolution, SHA pass-through, change detection
  (lock differs ⇒ rebuild marker), reuse path (no network, no marker), unknown
  ref fails loud.
- `stack_image`: digest pass-through, tag→digest resolution (mocked via a
  fake `docker` shim in `PATH` for hermetic CI), change detection, fail-loud
  on bad ref.

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

No tracked per-service `.dockerignore` is added (would be in the wrong
place — Docker reads `.dockerignore` from the build context root, which is
`_source/`). `stack_source` writes `_source/.dockerignore` after every
checkout (see Design A).

---

## Design C — image services (two-tier)

**Classification rule:** images from `ghcr.io` → **digest class** (CI-built,
weaker tag curation; we want digest immutability). Images from other
registries (Docker Hub `library/*`, `pgvector/*`, `eceasy/*`) → **tag class**
(curated upstream tags; small drift acceptable).

### Tag class — compose interpolation only

No build-time resolver. The compose `image:` line uses the lever directly
with a tracked default tag:

| Service | `image:` (new) |
|---|---|
| `pg` (`services/pg/compose.yaml`) | `pgvector/pgvector:${PG_VERSION:-pg18}` |
| `redis` (`services/redis/compose.yaml`) | `redis:${REDIS_VERSION:-8.6.3}` |
| `rabbitmq` (`services/rabbitmq/compose.yaml`) | `rabbitmq:${RABBITMQ_VERSION:-4.3.0-management}` |
| `cliproxyapi` | already `eceasy/cli-proxy-api:${CLIPROXY_VERSION:-v7.1.11}` — **no change** (existing precedent). |

`CLIPROXY_VERSION` keeps its existing name (grandfathered) — renaming to
`CLIPROXYAPI_VERSION` is gratuitous churn for users.

### Digest class — `stack_image` resolver

Affected services: `litellm`, `hindsight`, `firecrawl-api`,
`firecrawl-playwright`, `firecrawl-postgres`.

Each service's `build.sh` adds a `stack_image` call per image. The compose
`image:` line becomes `${<NAME>_IMAGE:?run "just build" to resolve <NAME>_VERSION}`.

**Var naming and defaults** (current pin → annotated default):

| Lever | Repo | Current digest (becomes annotated default) | Compose `image:` |
|---|---|---|---|
| `LITELLM_VERSION` | `ghcr.io/berriai/litellm-database` | `sha256:7bb80500…  # tag <annotate-on-bump>` | `${LITELLM_IMAGE:?…}` |
| `HINDSIGHT_VERSION` | `ghcr.io/vectorize-io/hindsight` | (current digest)  # tag … | `${HINDSIGHT_IMAGE:?…}` |
| `FIRECRAWL_API_VERSION` | `ghcr.io/firecrawl/firecrawl` | `sha256:fb156ea5…  # tag …` | `${FIRECRAWL_API_IMAGE:?…}` |
| `FIRECRAWL_PLAYWRIGHT_VERSION` | `ghcr.io/firecrawl/playwright-service` | `sha256:9e07…  # tag …` | `${FIRECRAWL_PLAYWRIGHT_IMAGE:?…}` |
| `FIRECRAWL_PG_VERSION` | `ghcr.io/firecrawl/nuq-postgres` | `sha256:f9388bd2…  # tag …` | `${FIRECRAWL_PG_IMAGE:?…}` |

`firecrawl/build.sh` makes 3 `stack_image` calls; `hindsight/build.sh` and
`litellm/build.sh` make one each. Defaults' tag annotations are filled in
during implementation by inspecting each image's tag list (a one-time
research step — written as `# tag X` comments).

**`.image-digest` sidecar files** (currently in `services/{litellm,firecrawl,
hindsight}/`) become **redundant** — the digest now lives in code (the
tracked default arg + comment) and in `.stack/<svc>/.image.lock`. Delete
them as part of the refactor.

---

## Design D — `.stack/.env` conventions + ergonomics

New documented block in `.stack.env.example`:

```sh
# === Service versions (all OPTIONAL; defaults are the tracked annotated pins).
# Tag class — accepts an upstream tag. Pulled as-is (small drift accepted):
#   PG_VERSION=pg18                    REDIS_VERSION=8.6.3
#   RABBITMQ_VERSION=4.3.0-management  CLIPROXY_VERSION=v7.1.11
# Digest class — accepts a tag (resolved to digest) OR a sha256 digest:
#   LITELLM_VERSION=v1.78.6            HINDSIGHT_VERSION=…
#   FIRECRAWL_API_VERSION=…  FIRECRAWL_PLAYWRIGHT_VERSION=…  FIRECRAWL_PG_VERSION=…
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
  .source.lock         # source class only — requested + resolved_sha
  .image.lock          # digest-class image only — requested + resolved_digest
  .source.rebuild      # transient marker; build.sh removes after dc build
  .generated.env       # already exists; gains <SVC_UC>_IMAGE for digest class
```

All gitignored (under `.stack/`). The tracked source of truth for
reproducibility is the annotated default in `build.sh`/`compose.yaml`.

---

## Migration

The refactor is **non-destructive by construction**: every tracked default
equals the exact pin in use today.

1. Land helpers + tests in `lib/stacklib.sh` / `lib/stacklib.test.sh`.
2. Convert 4 `_source` `build.sh` files to `stack_source`; add 4
   `.dockerignore` files. `_source` dirs already exist on live stacks — the
   first `stack_source` call against them: `.git` absent → re-clone with
   `.git`. Heavy but one-time per stack. The user's existing `_source`
   contents (pinned commit) are unchanged after re-clone+checkout, so the
   built image is the same; layer cache holds.
3. Convert 3 tag-class compose `image:` lines (`pg`/`redis`/`rabbitmq`).
   Default tag = current value. `dc up -d` is a no-op (same image).
4. Convert 5 digest-class images: edit `compose.yaml` to `${…_IMAGE:?…}`;
   add `stack_image` call(s) in each affected `build.sh`. First `just build`
   resolves the default digest → writes `<SVC>_IMAGE` env. `dc up -d` then
   sees the same digest currently in compose → no container recreate.
5. Delete `services/{litellm,firecrawl,hindsight}/.image-digest` sidecars.
6. Update `.stack.env.example` with the version block.
7. Update README pinning section (current behavior description is stale).

Live-stack ordering: `just build` (resolves all digests, writes locks/env
files) → `dc up -d` (no-op on unchanged pins). No volume or container
touched unless the user has set a `<SVC>_VERSION` override.

---

## Acceptance criteria

1. `lib/stacklib.sh` provides `stack_source` and `stack_image`; both have
   fixture tests in `lib/stacklib.test.sh` covering tag-resolve, SHA/digest
   pass-through, change detection, reuse (no network), and fail-loud on bad
   refs. Tests pass without network (fake `docker` shim for `stack_image`).
2. Every `_source` `build.sh` (honcho, honcho-ui, camofox-browser,
   browser-use) calls `stack_source` and contains **no** `git clone`/
   `checkout`/`rm -rf .git` lines of its own. After `stack_source` runs,
   `_source/.dockerignore` exists and contains `.git/` on its own line
   (build-context exclusion).
3. `_source` dirs retain `.git` after a fresh `just build`
   (`git -C services/<svc>/_source rev-parse HEAD` succeeds; equals the
   value in `.stack/<svc>/.source.lock`'s `resolved_sha`).
4. Tag-class images use compose `${<SVC>_VERSION:-<default-tag>}`; digest-
   class images use `${<SVC>_IMAGE:?…}` with `<SVC>_IMAGE` populated by
   `stack_image` in the relevant `build.sh`.
5. **Non-destructive default round-trip**: on the live stack, after the
   refactor, `just build` followed by `dc up -d` recreates **zero**
   containers (all resolved digests/tags match the pre-refactor state).
6. **Bump round-trip** (verified once with a no-op-equivalent bump, e.g.
   setting `LITELLM_VERSION` to the current resolved tag): `just build`
   detects no change after the first run, writes/updates the lock, and a
   second `just build` is a no-op (reuse path; no network for source).
7. `services/{litellm,firecrawl,hindsight}/.image-digest` are removed.
8. `.stack.env.example` documents every lever; README's pinning section is
   updated to describe the helpers + two-tier model.

## Risks

- **Tag class accepts upstream drift.** A maintainer of `redis:8.6.3` could
  re-tag (uncommon for Docker Official Images but possible). Mitigation:
  this is the explicitly accepted tradeoff for ergonomics; digest class
  exists for images where it isn't acceptable. The full classification rule
  is `ghcr.io → digest` and is auditable.
- **`docker buildx imagetools inspect` is the resolver dependency.**
  Requires Docker 20.10+ with buildx (OrbStack ships this; the project
  already uses `dc build`/`buildx`). Mitigation: `stack_image` fails loud
  with a clear message if the inspect fails (network/registry).
- **Fresh-checkout dependency on `just build` before `dc up -d`.** Compose
  `${LITELLM_IMAGE:?…}` errors loudly if `just build` hasn't been run
  (because the per-service `.generated.env` doesn't yet exist). This is by
  design (fail-loud > silently using wrong image); the `:?` message points
  users at `just build`. README/quickstart already prescribes
  `setup → build → start` in that order.
- **First-time `stack_source` against existing `_source` re-clones.**
  Because we keep `.git`, an existing `.git`-less `_source` triggers a
  re-clone (`if [ ! -d src/.git ]`). One-time cost per existing stack;
  produces byte-identical source after checkout to the same pinned SHA.
- **Lock-vs-default drift on a fresh checkout.** A fresh `git clone` of the
  repo lands without any `.stack/<svc>/.source.lock`. First `just build`
  resolves the tracked default → checks out → writes lock. Reproducible:
  the default in tracked `build.sh` is the source of truth; lock is
  optimization.
