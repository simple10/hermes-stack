# Camofox-Browser Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `jo-inc/camofox-browser` as an opt-in, standalone stack service (`[camofox-browser]` profile), built from a pinned gitignored `_source/`, with a generated `CAMOFOX_ACCESS_KEY`; operational only (Hermes wiring out of scope).

**Architecture:** One standalone Node HTTP service on port 9377, no backend deps (no pg/redis/rabbitmq/litellm), no provisioner/preflight/prestart/poststart. Build-from-pinned-`_source/` via `Dockerfile.ci` (honcho/honcho-ui precedent). Secret is generated into `.stack/camofox-browser.generated.env` and reaches Compose only via `dc`'s hermetic `--env-file` (gotcha #16).

**Tech Stack:** Docker Compose v2, bash, just, Node 22 / Camoufox (Firefox). Platform darwin/OrbStack (arm64). Spec: `docs/superpowers/specs/2026-05-18-camofox-browser-service-design.md`.

---

## Workspace safety (READ FIRST — applies to every task)

- The live `aitools` stack + this checkout are **shared** with other agents. Commits must be **scoped + additive**; never `git reset/rebase/push`; never modify unrelated files.
- **Never mutate the live `.stack/`** and never run `dc up/down/build` against project `aitools`. All bring-up/validation happens in an **isolated throwaway Compose project** built from an rsync'd copy (method below). Image builds are daemon-global and additive (a new image + layer cache) — that is acceptable and non-destructive; container/volume/network isolation is by project name.
- Commit identity is explicit (no global git config): `git -c user.name="Joe Johnston" -c user.email="<redacted>" commit`.
- `_source/` is created by `build.sh` at run time and is gitignored (`.gitignore:6 **/_source/`) — **never** `git add` it.

### Isolated validation venue (current, post-hermetic-stacklib method)

The old `STACK_ROOT=…` override is gone (stacklib derives root from its own
location and dies loud otherwise). To validate in isolation, rsync the repo
and source **the copy's own** stacklib:

```bash
LIVE=/Users/joe/Development/ai-tools/openclaw/hermes-stack
T="$(mktemp -d)/cfx"
rsync -a --exclude '.git' --exclude '*/_source/' "$LIVE/" "$T/"
mkdir -p "$T/.stack"
# Minimal synthesized env — distinct project so containers/volumes/network are
# isolated; NO live secrets copied (camofox needs none; build.sh mints its own).
printf 'COMPOSE_PROJECT_NAME=cfxval\nCOMPOSE_PROFILES=camofox-browser\n' > "$T/.stack/.env"
cd "$T"
set -a; source "$T/lib/stacklib.sh"; set +a   # self-resolves to $T (gotcha #16)
test "$STACK_DIR" = "$T/.stack" || { echo "FATAL: stacklib resolved $STACK_DIR (expected $T/.stack)"; exit 1; }
```

Teardown after any task that brought containers up:
`dc down -v --remove-orphans 2>/dev/null; rm -rf "$(dirname "$T")"`.
Assert live untouched: `docker ps -a --filter label=com.docker.compose.project=aitools --format '{{.Names}}' | wc -l` is unchanged by your work (you only ever touch project `cfxval`).

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `services/camofox-browser/compose.yaml` | Create | The service: build-from-`_source`, profile `[camofox-browser]`, port 9377, healthcheck, volume, resource levers. |
| `services/camofox-browser/build.sh` | Create | Gen-once `CAMOFOX_ACCESS_KEY`; clone+pin `_source/`; eager `dc build`. |
| `docker-compose.yaml` | Modify (line 19→20) | `include:` += the new compose. |
| `.stack.env.example` | Modify (after line 61) | Document the opt-in profile + optional levers. |
| `README.md` | Modify (line 28 area + services list) | Tree comment + service entry. |

No `lib/setup.sh` change (every Compose var is generated or has a `:-default`). No `machines/hermes/` change (Hermes out of scope).

---

## Task 1: Service compose file

**Files:**
- Create: `services/camofox-browser/compose.yaml`

- [ ] **Step 1: Create `services/camofox-browser/compose.yaml`**

```yaml
# camofox-browser — stealth headless-browser automation API (Camoufox/Firefox)
# for AI agents. profile [camofox-browser] (opt-in). STANDALONE: no pg/redis/
# rabbitmq/litellm, no provisioner/preflight/prestart/poststart. No upstream
# image — built from pinned services/camofox-browser/_source via Dockerfile.ci
# (honcho/honcho-ui precedent). Project-scoped (no container_name / no shared
# network); siblings reach it as camofox-browser:9377, external via
# camofox-browser.<project>.orb.local:9377. CAMOFOX_ACCESS_KEY is generated
# (services/camofox-browser/build.sh) into .stack/camofox-browser.generated.env
# and reaches the container ONLY via dc's hermetic --env-file (gotcha #16).
services:
  camofox-browser:
    build: { context: ./_source, dockerfile: Dockerfile.ci }
    profiles: [camofox-browser]
    restart: unless-stopped
    expose:
      - "9377"
    environment:
      CAMOFOX_PORT: "9377"
      CAMOFOX_ACCESS_KEY: ${CAMOFOX_ACCESS_KEY}
      MAX_OLD_SPACE_SIZE: ${CAMOFOX_HEAP_MB:-128}
    volumes:
      - camofox-data:/root/.camofox
    healthcheck:
      # /health is unauthenticated (no bearer needed). curl is installed by
      # Dockerfile.ci. start_period covers Camoufox/Xvfb first boot.
      test: ["CMD-SHELL", "curl -fsS http://localhost:9377/health || exit 1"]
      interval: 10s
      timeout: 6s
      retries: 20
      start_period: 30s
    cpus: ${CAMOFOX_CPU:-2}
    mem_limit: ${CAMOFOX_MEM:-2g}
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

volumes:
  camofox-data:
```

- [ ] **Step 2: Lint the YAML**

Run: `cd /Users/joe/Development/ai-tools/openclaw/hermes-stack && python3 -c "import yaml,sys; yaml.safe_load(open('services/camofox-browser/compose.yaml')); print('YAML OK')"`
Expected: `YAML OK`

- [ ] **Step 3: Commit**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add services/camofox-browser/compose.yaml
git -c user.name="Joe Johnston" -c user.email="<redacted>" \
  commit -m "feat(camofox-browser): service compose (standalone, profile [camofox-browser], build from _source)"
```

---

## Task 2: build.sh (generated key + pinned source + eager build)

**Files:**
- Create: `services/camofox-browser/build.sh`

- [ ] **Step 1: Create `services/camofox-browser/build.sh`**

```bash
#!/usr/bin/env bash
# camofox-browser/build.sh — own CAMOFOX_ACCESS_KEY (decentralized, gen-once)
# + fetch pinned _source + eager image build. Standalone service: no backend
# deps, no preflight/prestart/poststart.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/camofox-browser"
CAMOFOX_PIN="c9a90dafc76d2dfa0eb5d74fa36ef28f3ba98b29"  # jo-inc/camofox-browser pinned

# Own CAMOFOX_ACCESS_KEY (generated, hermetic). Read existing value first;
# never blind-regen (rotating would orphan any Hermes config already wired).
GEN="$STACK_DIR/camofox-browser.generated.env"
key="$(env_get "$GEN" CAMOFOX_ACCESS_KEY)"
[ -n "$key" ] || key="$(openssl rand -hex 32)"
env_upsert "$GEN" CAMOFOX_ACCESS_KEY "$key"
log "camofox-browser: CAMOFOX_ACCESS_KEY owned in camofox-browser.generated.env"

# Pinned build context (honcho precedent: reuse if present, else clone+pin,
# drop .git). rm a partial/corrupt clone (missing Dockerfile.ci) first.
if [ -d "$D/_source" ] && [ -f "$D/_source/Dockerfile.ci" ]; then
  log "camofox-browser: _source present (pinned build context) — reusing"
else
  log "camofox-browser: cloning jo-inc/camofox-browser @ $CAMOFOX_PIN"
  rm -rf "$D/_source"
  git clone https://github.com/jo-inc/camofox-browser "$D/_source"
  git -C "$D/_source" checkout "$CAMOFOX_PIN"
  rm -rf "$D/_source/.git"
fi

# Eager build (honcho-ui precedent) — surface the heavy Camoufox/Firefox
# build at `just build`, not mid-`just start`. First build downloads ~300MB
# Camoufox + apt Firefox/Xvfb deps (needs build-time network).
log "camofox-browser: building image (Dockerfile.ci)"
dc build camofox-browser
log "camofox-browser/build.sh DONE"
```

- [ ] **Step 2: Make it executable + bash-lint**

Run:
```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
chmod +x services/camofox-browser/build.sh
bash -n services/camofox-browser/build.sh && zsh -n services/camofox-browser/build.sh && echo "lint OK"
```
Expected: `lint OK` (portable; service scripts run under bash but must not be zsh-broken).

- [ ] **Step 3: Verify in the isolated venue — generated key is idempotent + source pins**

Set up the isolated venue (see "Isolated validation venue" above), then:
```bash
# (inside $T, copy's stacklib sourced)
bash "$T/services/camofox-browser/build.sh"
k1=$(grep '^CAMOFOX_ACCESS_KEY=' "$T/.stack/camofox-browser.generated.env" | cut -d= -f2-)
test -n "$k1" && echo "key minted (len ${#k1})"
test "$(stat -f '%Lp' "$T/.stack/camofox-browser.generated.env")" = 600 && echo "perms 600 OK"
test -f "$T/services/camofox-browser/_source/Dockerfile.ci" && echo "_source pinned OK"
test ! -d "$T/services/camofox-browser/_source/.git" && echo ".git dropped OK"
# idempotent: re-run reuses the SAME key, does not re-clone
bash "$T/services/camofox-browser/build.sh"
k2=$(grep '^CAMOFOX_ACCESS_KEY=' "$T/.stack/camofox-browser.generated.env" | cut -d= -f2-)
test "$k1" = "$k2" && echo "IDEMPOTENT: key stable across re-run"
docker images --format '{{.Repository}}:{{.Tag}}' | grep -i 'cfxval.*camofox\|camofox' | head && echo "image built OK"
```
Expected: each line prints its OK; `k1 == k2`; an image for the `cfxval` project exists. (First run is slow — multi-minute heavy build.)

- [ ] **Step 4: Commit** (build.sh only — `_source/` is gitignored)

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add services/camofox-browser/build.sh
git -c user.name="Joe Johnston" -c user.email="<redacted>" \
  commit -m "feat(camofox-browser): build.sh — gen-once CAMOFOX_ACCESS_KEY + pinned _source + eager build"
```

---

## Task 3: Wire into root compose + docs

**Files:**
- Modify: `docker-compose.yaml` (after line 19)
- Modify: `.stack.env.example` (after line 61)
- Modify: `README.md` (line 28 + services list near line 111)

- [ ] **Step 1: Add the include (root `docker-compose.yaml`)**

Replace the line:
```
  - services/firecrawl/compose.yaml
```
with:
```
  - services/firecrawl/compose.yaml
  - services/camofox-browser/compose.yaml
```

- [ ] **Step 2: Document the profile in `.stack.env.example`**

Insert immediately AFTER the line `# auto-pulls litellm. Extract routed via LiteLLM (FIRECRAWL_VIRTUAL_KEY).` and BEFORE the `COMPOSE_PROFILES=...` line:
```
# camofox-browser: OPTIONAL stealth headless-browser API (Camoufox/Firefox)
# for agents. Opt-in — add `camofox-browser`. STANDALONE (no backends);
# built from pinned _source. CAMOFOX_ACCESS_KEY is GENERATED into
# .stack/camofox-browser.generated.env (NOT hand-edited here). Optional
# levers (all have defaults; add only to override):
#   CAMOFOX_MEM=2g  CAMOFOX_CPU=2  CAMOFOX_HEAP_MB=128
```
(Do NOT change the `COMPOSE_PROFILES=` value — it stays opt-out.)

- [ ] **Step 3: Add the README tree comment (line 28 area)**

Insert after the `firecrawl/` tree line:
```
    camofox-browser/           # profile [camofox-browser] (opt-in); standalone Camoufox/Firefox automation API; built from pinned _source
```

- [ ] **Step 4: Add the README service entry**

Immediately AFTER the firecrawl bullet (the paragraph beginning `- **firecrawl** — service \`firecrawl\` (optional)…`, ending `…Extract routed via LiteLLM.`), insert:
```
- **camofox-browser** — service `camofox-browser` (optional), a stealth
  headless-browser automation API (Camoufox, a fingerprint-spoofing Firefox
  fork) for AI agents. Profile `[camofox-browser]`; opt-in. **Standalone** —
  no pg/redis/rabbitmq/litellm, no provisioner/preflight. No upstream image:
  built from a pinned gitignored `_source/` via `Dockerfile.ci`
  (honcho/honcho-ui precedent). `CAMOFOX_ACCESS_KEY` is generated into
  `.stack/camofox-browser.generated.env` (hermetic; gotcha #16) — read it
  there to wire Hermes. API on `:9377`, `/health` unauthenticated.
```

- [ ] **Step 5: Verify profile-gating + hermetic-config (read-only, isolated)**

`dc()` is hermetic (gotcha #16): it `env -i`-strips the caller's
`COMPOSE_PROFILES` and injects profiles from `$STACK_DIR/.env`. So toggle
the COPY's `.stack/.env` (safe — it's the throwaway copy) via the repo's own
`env_upsert`, not a caller env var. In the isolated venue (`$T`, copy's
stacklib sourced; run AFTER Task 2 so `_source` + generated.env exist):
```bash
# profile OFF -> service absent
env_upsert "$STACK_DIR/.env" COMPOSE_PROFILES ""
dc config --services 2>/dev/null | grep -qx 'camofox-browser' && echo "OFF: FAIL (present)" || echo "OFF: absent OK"
# profile ON -> service present
env_upsert "$STACK_DIR/.env" COMPOSE_PROFILES "camofox-browser"
dc config --services 2>/dev/null | grep -qx 'camofox-browser' && echo "ON: present OK" || echo "ON: FAIL (absent)"
# hermetic: a bogus host CAMOFOX_ACCESS_KEY must NOT reach Compose
export CAMOFOX_ACCESS_KEY=LEAKED_HOST_VALUE
n=$(dc config 2>/dev/null | grep -c 'LEAKED_HOST_VALUE' || true)
test "$n" = 0 && echo "HERMETIC OK: host CAMOFOX_ACCESS_KEY stripped (generated value used)"
unset CAMOFOX_ACCESS_KEY
# leave the copy's profile ON for Task 4
env_upsert "$STACK_DIR/.env" COMPOSE_PROFILES "camofox-browser"
```
Expected: `OFF: absent OK`, `ON: present OK`, `HERMETIC OK …`.

- [ ] **Step 6: Commit**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add docker-compose.yaml .stack.env.example README.md
git -c user.name="Joe Johnston" -c user.email="<redacted>" \
  commit -m "feat(camofox-browser): wire into root compose + document profile/levers (README, .stack.env.example)"
```

---

## Task 4: End-to-end isolated validation

**Files:** none (validation only — no commit unless a fix is needed; if a code fix is required, make it in the relevant earlier task's file and amend that task's commit with a new scoped commit).

- [ ] **Step 1: Bring the service up in the isolated venue**

Set up a FRESH isolated venue (see top — its `.stack/.env` already has
`COMPOSE_PROFILES=camofox-browser`, which is what hermetic `dc` reads;
naming the service explicitly on `up` is belt-and-suspenders):
```bash
bash "$T/services/camofox-browser/build.sh"          # mints key, pins _source, builds image
dc up -d camofox-browser
```

- [ ] **Step 2: Verify it reaches healthy**

Run:
```bash
for i in $(seq 1 30); do
  s=$(docker inspect -f '{{.State.Health.Status}}' cfxval-camofox-browser-1 2>/dev/null || echo none)
  echo "t=$((i*5))s $s"; [ "$s" = healthy ] && break; sleep 5
done
test "$s" = healthy && echo "HEALTHY OK"
```
Expected: reaches `healthy` (within ~start_period+; first boot launches Camoufox/Xvfb).

- [ ] **Step 3: Verify `/health` open, and the access key is enforced**

Run (exec inside the container — no host port is published, by design):
```bash
KEY=$(grep '^CAMOFOX_ACCESS_KEY=' "$T/.stack/camofox-browser.generated.env" | cut -d= -f2-)
# /health: no auth -> 200
docker exec cfxval-camofox-browser-1 sh -c 'curl -fsS -o /dev/null -w "%{http_code}\n" http://localhost:9377/health'
# protected route WITHOUT key -> rejected (401/403)
docker exec cfxval-camofox-browser-1 sh -c 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9377/tabs'
# protected route WITH key -> accepted (2xx)
docker exec cfxval-camofox-browser-1 sh -c "curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer $KEY' http://localhost:9377/tabs"
```
Expected: `/health` → `200`; `/tabs` no key → `401` or `403`; `/tabs` with key → `2xx` (e.g. `200`). If the bearer header name/scheme differs in this pinned build, consult `$T/services/camofox-browser/_source/README.md` / `openapi.json` and record the exact contract in the spec's "Risks" note (no code change needed — auth is upstream behavior).

- [ ] **Step 4: Teardown + assert live `aitools` untouched**

Run:
```bash
before=$(docker ps -a --filter label=com.docker.compose.project=aitools --format '{{.Names}}' | wc -l | tr -d ' ')
dc down -v --remove-orphans
rm -rf "$(dirname "$T")"
after=$(docker ps -a --filter label=com.docker.compose.project=aitools --format '{{.Names}}' | wc -l | tr -d ' ')
test "$before" = "$after" && echo "AITOOLS UNTOUCHED ($before==$after)"
```
Expected: `cfxval` project fully removed; `AITOOLS UNTOUCHED`.

- [ ] **Step 5: Record as-built**

Append a short "## As-built (validated 2026-05-18)" section to `docs/superpowers/specs/2026-05-18-camofox-browser-service-design.md` stating: image builds on arm64, container healthy, `/health` open, access key enforced, and the exact auth header/scheme observed (from Step 3). Commit:
```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add docs/superpowers/specs/2026-05-18-camofox-browser-service-design.md
git -c user.name="Joe Johnston" -c user.email="<redacted>" \
  commit -m "docs(spec): camofox-browser as-built (validated in isolated project)"
```

---

## Self-review checklist (run before declaring done)

- Spec coverage: Task1=compose; Task2=build.sh(gen key+pin+build); Task3=include+docs; Task4=acceptance criteria 1–5. Out-of-scope items (Hermes, plugins, VNC, API/ADMIN keys) intentionally absent. ✓
- No placeholders: every step has exact paths, full file contents, exact commands + expected output. ✓
- Type/name consistency: `camofox-browser` (dir == profile == compose service == build.sh trigger == container `cfxval-camofox-browser-1`); `CAMOFOX_ACCESS_KEY` / `.stack/camofox-browser.generated.env` / `CAMOFOX_{HEAP_MB,MEM,CPU}` consistent across spec, build.sh, compose, docs. ✓
- Hermetic-config: secret only in generated.env, reaches Compose via `dc` `--env-file`; Step 3.5 explicitly tests host-override is stripped. ✓
- Workspace safety: every bring-up is in an isolated rsync'd copy with synthesized minimal `.stack/.env` (no live secrets), distinct project `cfxval`, copy's own stacklib; live `.stack/`/`aitools` never touched; `_source/` never committed. ✓
