# Stack Config & Cross-Service Dependency Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make every service declare its cross-service dependencies in one
`service.env`, gate `pg`/`redis`/`rabbitmq` behind their own profiles, and
consolidate all mutable stack state under `.stack/<svc>/` — then migrate the
live `aitools` stack in place without regenerating any in-use password.

**Architecture:** New stacklib helpers (`stack_required`/`stack_profiles`/
`stack_backends`) expand `COMPOSE_PROFILES` from per-service
`services/<svc>/service.env` manifests; `dc()` injects the expanded set so
cross-profile `depends_on` always resolves; `just start` derives the
backends-first bring-up from `stack_backends`. Runtime configs, generated
envs, config hashes, and the litellm chatgpt token move under `.stack/<svc>/`;
compose binds become `../../.stack/<svc>/…`. The live stack is migrated by
copying bind-mounted artifacts (rollback-safe) and moving non-bound files,
then recreated non-destructively (volumes preserved).

**Tech Stack:** bash (`lib/stacklib.sh`), `just` (justfile), Docker Compose v5
(`docker-compose.yaml` + `services/*/compose.yaml`), OrbStack.

**Spec:** `docs/superpowers/specs/2026-05-19-stack-config-and-deps-cleanup-design.md`

**Concurrent-stack rule:** `.stack/` is shared & gitignored (not branch-scoped);
this migration touches the live `aitools` stack regardless of branch. Recreate
is non-destructive: `just down` removes containers, **never volumes**; never
run `docker volume rm`. Commit with explicit `git add <paths>`; check
`git diff --cached` before each commit; never stage another agent's hunks.

---

### Task 1: Feature branch

**Files:** none (git only)

- [ ] **Step 1: Branch off main (NOT a worktree — same checkout)**

Run:
```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git checkout -b feat/stack-config-deps-cleanup
git branch --show-current
```
Expected: `feat/stack-config-deps-cleanup`

- [ ] **Step 2: Confirm clean tree**

Run: `git status --porcelain`
Expected: empty (no output). If non-empty, stop and inspect — do not proceed.

---

### Task 2: Rename `services/postgres` → `services/pg`

Satisfies the spec invariant *directory == compose service == profile*. The
compose service stays named `pg` (no runtime change).

**Files:**
- Rename: `services/postgres/` → `services/pg/`
- Modify: `docker-compose.yaml` (include line)
- Modify: `justfile` (build recipe postgres ref)
- Modify: `services/pg/build.sh` (header comment only; DBENV path is Task 7)

- [ ] **Step 1: Verify the only code references**

Run: `grep -rn "services/postgres" justfile docker-compose.yaml lib/ services/ 2>/dev/null`
Expected exactly two hits: `docker-compose.yaml:10` and the justfile build line.

- [ ] **Step 2: Git-rename the directory**

Run:
```bash
git mv services/postgres services/pg
ls services/pg
```
Expected: `build.sh  compose.yaml  provision.sql` (whatever was there).

- [ ] **Step 3: Update the compose include**

In `docker-compose.yaml`, change:
```
  - services/postgres/compose.yaml
```
to:
```
  - services/pg/compose.yaml
```

- [ ] **Step 4: Update the justfile build reference**

In `justfile`, in the `build:` recipe, change:
```
     bash "{{root}}/services/postgres/build.sh"; \
```
to:
```
     bash "{{root}}/services/pg/build.sh"; \
```

- [ ] **Step 5: Verify no stale references remain**

Run: `grep -rn "services/postgres" . --exclude-dir=.git --exclude-dir=docs 2>/dev/null`
Expected: no output.

- [ ] **Step 6: Verify just still parses**

Run: `just --list >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yaml justfile services/pg
git diff --cached --stat
git commit -m "refactor(pg): rename services/postgres -> services/pg (dir==service==profile)"
```

---

### Task 3: Per-service `service.env` manifests

**Files:**
- Create: `services/pg/service.env`, `services/redis/service.env`,
  `services/rabbitmq/service.env`
- Create: `services/litellm/service.env`, `services/honcho/service.env`,
  `services/hindsight/service.env`, `services/firecrawl/service.env`,
  `services/honcho-ui/service.env`
- Reference (audit): every `services/*/compose.yaml`

- [ ] **Step 1: Audit each compose for cross-profile deps + substrate use**

Run:
```bash
for s in agentmemory cliproxyapi honcho-ui camofox-browser litellm honcho hindsight firecrawl; do
  echo "== $s =="
  grep -nE 'depends_on|@pg:|//pg:|POSTGRES_HOST|redis://redis|REDIS[A-Z_]*: *redis|amqp://rabbitmq|rabbitmq:|http://litellm|//honcho-api|honcho-api' "services/$s/compose.yaml" 2>/dev/null
done
```
Expected (decision rule): a `service.env` with `SERVICE_REQUIRES=<profiles>`
for every profile whose service is a **cross-profile `depends_on` target** or
whose hostname (`pg`/`redis`/`rabbitmq`/`litellm`/`honcho-api`) appears in
`environment:`. `agentmemory`/`cliproxyapi`/`camofox-browser`: if the audit
shows none, create **no** file for them.

- [ ] **Step 2: Create the substrate manifests**

`services/pg/service.env`:
```sh
# pg substrate: single-service profile (dir==service==profile==pg).
SERVICE_KIND=backend
```
`services/redis/service.env`:
```sh
# redis substrate: single-service profile.
SERVICE_KIND=backend
```
`services/rabbitmq/service.env`:
```sh
# rabbitmq substrate: single-service profile (was gated by [firecrawl]).
SERVICE_KIND=backend
```

- [ ] **Step 3: Create the consumer manifests**

`services/litellm/service.env`:
```sh
# litellm-provision -> pg; litellm uses REDIS_URL (no compose depends_on).
SERVICE_REQUIRES=pg,redis
```
`services/honcho/service.env`:
```sh
# honcho: CONNECTION_URI -> pg ; redis://redis.
SERVICE_REQUIRES=pg,redis
```
`services/hindsight/service.env`:
```sh
# hindsight: provision.sql / @pg.
SERVICE_REQUIRES=pg
```
`services/firecrawl/service.env`:
```sh
# firecrawl-api depends_on redis, rabbitmq, and litellm (cross-profile).
# Uses its own firecrawl-postgres, NOT shared pg.
SERVICE_REQUIRES=redis,rabbitmq,litellm
```
`services/honcho-ui/service.env`:
```sh
# honcho-ui depends_on honcho-api (cross-profile -> honcho).
SERVICE_REQUIRES=honcho
```

- [ ] **Step 4: Verify the manifests parse with env_get**

Run:
```bash
bash -c '. lib/stacklib.sh; for s in pg redis rabbitmq litellm honcho hindsight firecrawl honcho-ui; do
  printf "%s: KIND=%s REQ=%s\n" "$s" "$(env_get services/$s/service.env SERVICE_KIND)" "$(env_get services/$s/service.env SERVICE_REQUIRES)"; done'
```
Expected: pg/redis/rabbitmq show `KIND=backend REQ=`; litellm/honcho show
`KIND= REQ=pg,redis`; hindsight `REQ=pg`; firecrawl `REQ=redis,rabbitmq,litellm`;
honcho-ui `REQ=honcho`.

- [ ] **Step 5: Commit**

```bash
git add services/*/service.env
git diff --cached --stat
git commit -m "feat(stack): per-service service.env manifests (SERVICE_REQUIRES/SERVICE_KIND)"
```

---

### Task 4: stacklib helpers (`stack_required`/`stack_profiles`/`stack_backends`)

**Files:**
- Modify: `lib/stacklib.sh` (add functions after `stack_project`, ~line 54)
- Create: `lib/stacklib.test.sh` (unit/integration test over real manifests)

- [ ] **Step 1: Write the failing test**

Create `lib/stacklib.test.sh`:
```bash
#!/usr/bin/env bash
# Tests for stack_required / stack_profiles / stack_backends.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. lib/stacklib.sh

fail=0
# set-equality: args = "actual" "expected-space-list"
seteq() {
  local a b
  a="$(printf '%s\n' $1 | sort | tr '\n' ' ')"
  b="$(printf '%s\n' $2 | sort | tr '\n' ' ')"
  if [ "$a" = "$b" ]; then echo "ok: [$1] == {$2}"; else
    echo "FAIL: got [$a] want [$b]"; fail=1; fi
}

# stack_profiles is comma-joined -> normalize to spaces for set compare
seteq "$(stack_profiles 'litellm,honcho' | tr ',' ' ')"  'litellm honcho pg redis'
seteq "$(stack_profiles 'honcho-ui' | tr ',' ' ')"       'honcho-ui honcho pg redis'
seteq "$(stack_profiles 'firecrawl' | tr ',' ' ')"       'firecrawl redis rabbitmq litellm pg'
# stack_backends is already space-separated
seteq "$(stack_backends 'litellm,honcho,cliproxyapi,honcho-ui')" 'pg redis'
seteq "$(stack_backends 'firecrawl')"                 'pg redis rabbitmq'
seteq "$(stack_backends 'cliproxyapi')"               ''
exit $fail
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bash lib/stacklib.test.sh`
Expected: FAIL (e.g. `stack_profiles: command not found` / non-zero exit).

- [ ] **Step 3: Implement the helpers**

In `lib/stacklib.sh`, immediately after the `stack_project() { … }` line, add:
```bash
# _svc_requires PROFILE — SERVICE_REQUIRES from services/PROFILE/service.env (csv or empty).
_svc_requires() { env_get "$STACK_ROOT/services/$1/service.env" SERVICE_REQUIRES; }

# stack_required [SEED_CSV] — space-separated fixpoint expansion of the active
# profiles' SERVICE_REQUIRES. SEED defaults to COMPOSE_PROFILES in .stack/.env.
# Cycle-safe (bounded worklist; each profile visited once).
stack_required() {
  local seed; seed="${1:-$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)}"
  local out="" work p r
  work="$(printf '%s' "$seed" | tr ',' ' ')"
  while [ -n "$(printf '%s' "$work" | tr -d '[:space:]')" ]; do
    local next=""
    for p in $work; do
      case " $out " in *" $p "*) continue;; esac
      out="$out $p"
      for r in $(_svc_requires "$p" | tr ',' ' '); do
        [ -n "$r" ] && next="$next $r"
      done
    done
    work="$next"
  done
  printf '%s' "$out" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' ' | sed 's/ $//'
}

# stack_profiles [SEED_CSV] — COMPOSE_PROFILES ∪ stack_required, COMMA-joined
# (ready for the COMPOSE_PROFILES env var). Used by dc().
stack_profiles() {
  local seed; seed="${1:-$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)}"
  stack_required "$seed" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | paste -sd, -
}

# stack_backends [SEED_CSV] — SPACE-separated subset of stack_profiles whose
# services/<name>/service.env declares SERVICE_KIND=backend. Valid `dc up -d`
# targets (dir==service==profile for substrate). Used by `just start`.
stack_backends() {
  local seed; seed="${1:-$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)}"
  local n out=""
  for n in $(stack_required "$seed"); do
    [ "$(env_get "$STACK_ROOT/services/$n/service.env" SERVICE_KIND)" = "backend" ] \
      && out="$out $n"
  done
  printf '%s' "$out" | sed 's/^ //'
}
```

- [ ] **Step 4: Run the test; verify it passes**

Run: `bash lib/stacklib.test.sh`
Expected: all `ok:` lines, exit 0.

- [ ] **Step 5: Verify default-stack resolution against live .stack/.env**

Run:
```bash
bash -c '. lib/stacklib.sh; echo "profiles=$(stack_profiles)"; echo "backends=$(stack_backends)"'
```
Expected: `profiles=litellm,honcho,cliproxyapi,honcho-ui,pg,redis` (order may
vary; pg+redis present, no rabbitmq); `backends=pg redis`.

- [ ] **Step 6: Commit**

```bash
git add lib/stacklib.sh lib/stacklib.test.sh
git diff --cached --stat
git commit -m "feat(stacklib): stack_required/stack_profiles/stack_backends + tests"
```

---

### Task 5: Substrate profiles on pg/redis/rabbitmq compose

**Files:**
- Modify: `services/pg/compose.yaml`, `services/redis/compose.yaml`,
  `services/rabbitmq/compose.yaml`

- [ ] **Step 1: pg — add profile, fix header comment**

In `services/pg/compose.yaml`: change the header line
`# postgres (pgvector). No profile => always-on shared backend.`
to
`# postgres (pgvector). profile [pg] — pulled in via SERVICE_REQUIRES=pg.`
and under `  pg:` add `profiles: [pg]` immediately after the
`    image: pgvector/pgvector:pg18` line:
```
    image: pgvector/pgvector:pg18
    profiles: [pg]
```

- [ ] **Step 2: redis — add profile, fix header comment**

In `services/redis/compose.yaml`: change
`# redis. No profile => always-on shared backend. Project-scoped (no`
to
`# redis. profile [redis] — pulled in via SERVICE_REQUIRES=redis. Project-scoped (no`
and after `    image: redis:8.6.3` add:
```
    image: redis:8.6.3
    profiles: [redis]
```

- [ ] **Step 3: rabbitmq — own profile**

In `services/rabbitmq/compose.yaml`, change:
```
    profiles: ["firecrawl"]
```
to:
```
    profiles: [rabbitmq]
```
Also update its header comment line `# rabbitmq. profile [firecrawl] — …`
to `# rabbitmq. profile [rabbitmq] — pulled in via SERVICE_REQUIRES=rabbitmq.`
(keep the rest of the comment).

- [ ] **Step 4: Verify compose still parses (structure only)**

Run: `docker compose -f docker-compose.yaml --profile pg --profile redis --profile rabbitmq config --services 2>/dev/null | sort | tr '\n' ' '; echo`
Expected: includes `pg redis rabbitmq` (plus any always-on; no error).

- [ ] **Step 5: Commit**

```bash
git add services/pg/compose.yaml services/redis/compose.yaml services/rabbitmq/compose.yaml
git diff --cached --stat
git commit -m "feat(substrate): pg/redis/rabbitmq each own their profile"
```

---

### Task 6: Wire `dc()` and `just start` to the helpers

**Files:**
- Modify: `lib/stacklib.sh` (`dc()` profile line)
- Modify: `justfile` (`start:` backends-first line)

- [ ] **Step 1: Point `dc()` at `stack_profiles`**

In `lib/stacklib.sh`, in `dc()`, change:
```
  prof="$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)"
```
to:
```
  prof="$(stack_profiles)"
```

- [ ] **Step 2: Verify dc injects the expanded set**

Run:
```bash
bash -c '. lib/stacklib.sh; dc config --services 2>/dev/null | sort | tr "\n" " "; echo'
```
Expected: the service list includes `pg` and `redis` (driven by the injected
expanded `COMPOSE_PROFILES`); no `rabbitmq` with the default `.stack/.env`;
no error.

- [ ] **Step 3: Derive backends-first bring-up in `just start`**

In `justfile`, in the `start:` recipe, replace the line:
```
     dc up -d pg redis; \
```
with:
```
     b="$(stack_backends)"; [ -n "$b" ] && dc up -d $b; \
```
The recipe already sources `{{lib}}` at its top, so `stack_backends` is in
scope (the `$( )` subshell inherits it). The `[ -n "$b" ]` guard is critical:
a bare `dc up -d` (no args) would start the **whole** stack prematurely —
only run it when there is at least one backend. With the default profiles
`$b` = `pg redis`.

- [ ] **Step 4: Verify just parses and the line expands**

Run:
```bash
just --list >/dev/null && echo PARSE_OK
just -n start 2>&1 | grep -m1 'up -d'
```
Expected: `PARSE_OK`; the printed `dc up -d …` line contains `pg redis`.

- [ ] **Step 5: Commit**

```bash
git add lib/stacklib.sh justfile
git diff --cached --stat
git commit -m "feat(stack): dc() uses stack_profiles; start derives backends from stack_backends"
```

---

### Task 7: Relocate runtime configs/env/hashes to `.stack/<svc>/` (code only)

No live files move yet — only the code that reads/writes/binds them.

**Files:**
- Modify: `lib/stacklib.sh` (`render_template`, `dc()` env-file glob)
- Modify (ALL flat `*.generated.env` users): `services/pg/build.sh`,
  `services/litellm/build.sh`, `services/honcho/build.sh`,
  `services/hindsight/build.sh`, `services/firecrawl/build.sh`,
  `services/camofox-browser/build.sh`, `services/litellm/preflight.sh`,
  `machines/hermes/build.sh`, `machines/hermes/start.sh`
- Modify: `services/litellm/compose.yaml`, `services/honcho/compose.yaml`,
  `services/cliproxyapi/compose.yaml`
- Modify: `justfile` (`reconfigure` recipe)

> **Why so many:** the new `dc()` glob is `.stack/*/.generated.env`. ANY
> script still reading/writing the flat `.stack/<svc>.generated.env` would
> (a) write a file Compose no longer sees, and (b) find its value "missing"
> and **regenerate it** (firecrawl password) or **re-mint** it (litellm
> virtual keys read by honcho/hermes/agentmemory/hindsight + the hermes
> machine). Every one must move to `.stack/<svc>/.generated.env`.

- [ ] **Step 1: `render_template` writes under `.stack/<svc>/`**

In `lib/stacklib.sh`, in `render_template`, replace:
```
  local hdir="$STACK_DIR/.config-hashes"; mkdir -p "$hdir"
  local hf="$hdir/${svc}.$(basename "$out").sha256"
```
with:
```
  local hdir="$STACK_DIR/$svc/.config-hashes"; mkdir -p "$hdir"
  local hf="$hdir/$(basename "$out").sha256"
```
(The `out` path itself is supplied by callers — updated in Steps 3–4.)

- [ ] **Step 2: `dc()` env-file glob → per-service**

In `lib/stacklib.sh`, in `dc()`, change the heredoc line:
```
$(ls "$STACK_DIR"/*.generated.env 2>/dev/null)
```
to:
```
$(ls "$STACK_DIR"/*/.generated.env 2>/dev/null)
```

- [ ] **Step 3: `pg/build.sh` superpass path**

In `services/pg/build.sh`, change:
```
DBENV="$STACK_DIR/db.generated.env"
```
to:
```
DBENV="$STACK_DIR/pg/.generated.env"; mkdir -p "$(dirname "$DBENV")"
```

- [ ] **Step 4: Every flat `*.generated.env` path → `.stack/<svc>/.generated.env`**

General rule for each file below: add `mkdir -p "$STACK_DIR/<svc>"` before
first use of `GEN`/render, repoint the path, and delete the now-dead
`db.generated.env` fallback line (confirmed a no-op: that file holds only
`POSTGRES_SUPERPASS`).

`services/litellm/build.sh`:
- `render_template "$D/config.yaml.template" "$D/config.runtime.yaml" litellm`
  → `mkdir -p "$STACK_DIR/litellm"; render_template "$D/config.yaml.template" "$STACK_DIR/litellm/config.runtime.yaml" litellm`
- `GEN="$STACK_DIR/litellm.generated.env"` → `GEN="$STACK_DIR/litellm/.generated.env"`
- delete: `[ -n "$pw" ] || pw="$(env_get "$STACK_DIR/db.generated.env" LITELLM_DB_PASSWORD)"`

`services/honcho/build.sh`:
- before the `sed … > "$D/config.runtime.toml"` line add `mkdir -p "$STACK_DIR/honcho"`;
  change `> "$D/config.runtime.toml"` → `> "$STACK_DIR/honcho/config.runtime.toml"`
- `GEN="$STACK_DIR/honcho.generated.env"` → `GEN="$STACK_DIR/honcho/.generated.env"`
- delete: `[ -n "$pw" ] || pw="$(env_get "$STACK_DIR/db.generated.env" HONCHO_DB_PASSWORD)"`

`services/hindsight/build.sh`:
- `GEN="$STACK_DIR/hindsight.generated.env"` → `mkdir -p "$STACK_DIR/hindsight"; GEN="$STACK_DIR/hindsight/.generated.env"`
- delete: `[ -n "$pw" ] || pw="$(env_get "$STACK_DIR/db.generated.env" HINDSIGHT_DB_PASSWORD)"`

`services/firecrawl/build.sh`:
- `GEN="$STACK_DIR/firecrawl.generated.env"` → `mkdir -p "$STACK_DIR/firecrawl"; GEN="$STACK_DIR/firecrawl/.generated.env"`
  (FIRECRAWL_DB_PASSWORD + FIRECRAWL_BULL_AUTH_KEY — must not regenerate.)

`services/camofox-browser/build.sh`:
- `GEN="$STACK_DIR/camofox-browser.generated.env"` → `mkdir -p "$STACK_DIR/camofox-browser"; GEN="$STACK_DIR/camofox-browser/.generated.env"`

`services/litellm/preflight.sh` (mints/validates the virtual keys read by
honcho/hermes/agentmemory/hindsight):
- `GEN="$STACK_DIR/litellm.generated.env"` → `mkdir -p "$STACK_DIR/litellm"; GEN="$STACK_DIR/litellm/.generated.env"`

`machines/hermes/build.sh`:
- `GEN="$STACK_DIR/litellm.generated.env"` → `GEN="$STACK_DIR/litellm/.generated.env"`

`machines/hermes/start.sh`:
- `GEN="$STACK_DIR/litellm.generated.env"` → `GEN="$STACK_DIR/litellm/.generated.env"`

Then sanity-grep — there must be **no** remaining flat reference:
Run: `grep -rn '\.stack/[a-z-]*\.generated\.env\|STACK_DIR/[a-z-]*\.generated\.env\|db\.generated\.env' lib services machines justfile | grep -v '\.generated\.env"' | grep -vi '^.*#' || echo NONE_LEFT`
Expected: no live (non-comment) flat path; comments may remain (tidy
`pg/build.sh` lines 3–4 + the `db.generated.env fallback` comments if quick).

- [ ] **Step 5: compose binds → `../../.stack/<svc>/…`**

`services/litellm/compose.yaml`:
- `- ./config.runtime.yaml:/app/config.yaml:ro`
  → `- ../../.stack/litellm/config.runtime.yaml:/app/config.yaml:ro`
- `- ./chatgpt:/root/.codex/chatgpt`
  → `- ../../.stack/litellm/chatgpt:/root/.codex/chatgpt`

`services/honcho/compose.yaml` (all three occurrences — honcho-api,
honcho-deriver, and the provisioner):
- `- ./config.runtime.toml:/app/config.toml:ro`
  → `- ../../.stack/honcho/config.runtime.toml:/app/config.toml:ro`

`services/cliproxyapi/compose.yaml`:
- `- ./config.runtime.yaml:/CLIProxyAPI/config.yaml:ro`
  → `- ../../.stack/cliproxyapi/config.runtime.yaml:/CLIProxyAPI/config.yaml:ro`

- [ ] **Step 6: `just reconfigure` writes under `.stack/<svc>/`**

In `justfile`, the `reconfigure svc:` recipe currently sets
`d="{{root}}/services/{{svc}}"` and renders `o="$d/config.runtime.$ext"`.
Change the output/backup target so configs render under `.stack`:
- `t="$d/config.$ext.template"; o="$d/config.runtime.$ext";`
  → `t="$d/config.$ext.template"; o="{{root}}/.stack/{{svc}}/config.runtime.$ext"; mkdir -p "{{root}}/.stack/{{svc}}";`
(The template still lives in `services/<svc>/`; only the rendered output moves.)

- [ ] **Step 7: Verify parse only (live files not migrated yet — expect bind-source absent but no parse error)**

Run: `docker compose -f docker-compose.yaml --profile litellm --profile honcho config -q 2>&1 | grep -i 'undefined service\|yaml' || echo NO_STRUCTURE_ERRORS`
Expected: `NO_STRUCTURE_ERRORS` (missing bind *paths* are not a `config` error).

- [ ] **Step 8: Commit**

```bash
git add lib/stacklib.sh justfile \
  services/pg/build.sh services/litellm/build.sh services/honcho/build.sh \
  services/hindsight/build.sh services/firecrawl/build.sh \
  services/camofox-browser/build.sh services/litellm/preflight.sh \
  machines/hermes/build.sh machines/hermes/start.sh \
  services/litellm/compose.yaml services/honcho/compose.yaml services/cliproxyapi/compose.yaml
git diff --cached --stat
git commit -m "feat(stack): all generated.env/configs/hashes under .stack/<svc>/; binds via ../../.stack"
```

---

### Task 8: Profile-resolution acceptance test (non-destructive)

**Files:**
- Create: `lib/profiles.test.sh`

- [ ] **Step 1: Write the resolution test**

Create `lib/profiles.test.sh`:
```bash
#!/usr/bin/env bash
# For the default COMPOSE_PROFILES and each user profile individually,
# expand via stack_profiles and assert `docker compose config` resolves with
# NO "undefined service" (cross-profile depends_on satisfied). Non-destructive.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. lib/stacklib.sh

USER_PROFILES="litellm honcho honcho-ui cliproxyapi hindsight agentmemory firecrawl camofox-browser"
DEFAULT="$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)"
fail=0
check() {
  local label="$1" seed="$2" exp pf err
  exp="$(stack_profiles "$seed")"
  pf=""; for p in $(printf '%s' "$exp" | tr ',' ' '); do pf="$pf --profile $p"; done
  err="$(docker compose -f docker-compose.yaml --env-file "$STACK_DIR/.env" $pf config 2>&1 >/dev/null || true)"
  if printf '%s' "$err" | grep -qi 'undefined service'; then
    echo "FAIL [$label] seed=$seed exp=$exp"; printf '%s\n' "$err" | grep -i 'undefined service'; fail=1
  else
    echo "ok   [$label] -> $exp"
  fi
}
check default "$DEFAULT"
for p in $USER_PROFILES; do check "$p" "$p"; done
exit $fail
```

- [ ] **Step 2: Run it; verify PASS**

Run: `bash lib/profiles.test.sh`
Expected: all `ok` lines, exit 0. (If any `FAIL [..] undefined service`, the
offending profile's `service.env` is missing a `SERVICE_REQUIRES` entry — add
it in `services/<that>/service.env`, re-run, then amend Task 3's commit set.)

- [ ] **Step 3: Commit**

```bash
git add lib/profiles.test.sh
git commit -m "test(stack): non-destructive profile-resolution test (default + per-profile)"
```

---

### Task 9: Pre-migration password gate + snapshot

**Files:** none (verification only; snapshot is /tmp, not committed)

- [ ] **Step 1: Assert every in-use secret is present; snapshot hashes**

Run:
```bash
bash -c '
set -e
. lib/stacklib.sh
# file:KEY pairs — DB passwords AND the litellm-minted virtual keys (re-mint
# = effective regeneration; the user explicitly requires these preserved).
pairs="
db.generated.env:POSTGRES_SUPERPASS
litellm.generated.env:LITELLM_DB_PASSWORD
litellm.generated.env:HERMES_VIRTUAL_KEY
litellm.generated.env:HONCHO_VIRTUAL_KEY
litellm.generated.env:AGENTMEMORY_VIRTUAL_KEY
litellm.generated.env:HINDSIGHT_VIRTUAL_KEY
honcho.generated.env:HONCHO_DB_PASSWORD
hindsight.generated.env:HINDSIGHT_DB_PASSWORD
firecrawl.generated.env:FIRECRAWL_DB_PASSWORD
firecrawl.generated.env:FIRECRAWL_BULL_AUTH_KEY
"
snap=/tmp/stack-mig-snapshot.txt; : > "$snap"
for p in $pairs; do
  f="${p%%:*}"; k="${p##*:}"; v="$(env_get "$STACK_DIR/$f" "$k")"
  [ -n "$v" ] || { echo "ABORT: $k missing in $f"; exit 1; }
  printf "%s %s\n" "$k" "$(printf %s "$v" | shasum -a256 | cut -d" " -f1)" >> "$snap"
done
echo "gate OK; snapshot:"; cat "$snap"
'
```
Expected: `gate OK` + five `KEY <sha256>` lines. **If ABORT, stop the entire
migration** and report — do not proceed to Task 10.

---

### Task 10: Migrate the live `.stack/` (copy binds, move non-binds)

**Files:** live `.stack/` (gitignored) + `git mv` the tracked chatgpt README

- [ ] **Step 1: Move non-bind-mounted files (safe — not bound into containers)**

Run:
```bash
set -e
mkdir -p .stack/pg
[ -f .stack/db.generated.env ] && mv .stack/db.generated.env .stack/pg/.generated.env
for s in litellm honcho hindsight firecrawl camofox-browser; do
  mkdir -p ".stack/$s"
  [ -f ".stack/$s.generated.env" ] && mv ".stack/$s.generated.env" ".stack/$s/.generated.env"
done
# per-service config hashes
for h in .stack/.config-hashes/*; do
  [ -e "$h" ] || continue
  b="$(basename "$h")"; svc="${b%%.config.runtime.*}"; out="config.runtime.${b##*.config.runtime.}"
  mkdir -p ".stack/$svc/.config-hashes"; mv "$h" ".stack/$svc/.config-hashes/$out"
done
rmdir .stack/.config-hashes 2>/dev/null || true
ls -R .stack | sed 's/^/  /'
```
Expected: `.stack/pg/.generated.env`, `.stack/<svc>/.generated.env`, and
`.stack/<svc>/.config-hashes/config.runtime.*.sha256` present; no
`.stack/db.generated.env`, no `.stack/.config-hashes/`.

- [ ] **Step 2: Copy bind-mounted artifacts (originals stay for rollback)**

Run:
```bash
set -e
[ -e services/litellm/config.runtime.yaml ] && cp services/litellm/config.runtime.yaml .stack/litellm/config.runtime.yaml
[ -e services/honcho/config.runtime.toml ]  && cp services/honcho/config.runtime.toml  .stack/honcho/config.runtime.toml
[ -e services/cliproxyapi/config.runtime.yaml ] && { mkdir -p .stack/cliproxyapi; cp services/cliproxyapi/config.runtime.yaml .stack/cliproxyapi/config.runtime.yaml; }
mkdir -p .stack/litellm/chatgpt
[ -e services/litellm/chatgpt/auth.json ] && cp services/litellm/chatgpt/auth.json .stack/litellm/chatgpt/auth.json
ls -l .stack/litellm .stack/honcho .stack/litellm/chatgpt
```
Expected: copied `config.runtime.*` and `chatgpt/auth.json` present under
`.stack/…`; the `services/…` originals still exist.

- [ ] **Step 3: Relocate the tracked chatgpt README (docs, not state)**

Run:
```bash
git mv services/litellm/chatgpt/README.md services/litellm/README-chatgpt.md
rmdir services/litellm/chatgpt 2>/dev/null || true
git status --porcelain | grep -E 'README-chatgpt|chatgpt' || true
```
Expected: `R  services/litellm/chatgpt/README.md -> services/litellm/README-chatgpt.md`.

- [ ] **Step 4: Commit the tracked rename only**

```bash
git add services/litellm/README-chatgpt.md
git diff --cached --stat
git commit -m "docs(litellm): relocate chatgpt README out of state dir"
```

---

### Task 11: Rebuild & verify NO password regenerated

**Files:** none (runs `just build`, compares to Task 9 snapshot)

- [ ] **Step 1: Build (renders configs into .stack/<svc>/, reuses passwords)**

Run: `just build 2>&1 | tail -20`
Expected: completes (`build complete`); honcho/litellm/pg build logs say
"reusing"/"owned", **not** "generating".

- [ ] **Step 2: Assert every secret is byte-identical to the snapshot**

Run:
```bash
bash -c '
. lib/stacklib.sh
# map snapshot KEY -> its NEW per-service file
keyfile() { case "$1" in
  POSTGRES_SUPERPASS) echo pg/.generated.env;;
  LITELLM_DB_PASSWORD|*_VIRTUAL_KEY) echo litellm/.generated.env;;
  HONCHO_DB_PASSWORD) echo honcho/.generated.env;;
  HINDSIGHT_DB_PASSWORD) echo hindsight/.generated.env;;
  FIRECRAWL_DB_PASSWORD|FIRECRAWL_BULL_AUTH_KEY) echo firecrawl/.generated.env;;
esac; }
ok=1
while read -r k h; do
  cur="$STACK_DIR/$(keyfile "$k")"
  v="$(env_get "$cur" "$k")"; g="$(printf %s "$v" | shasum -a256 | cut -d" " -f1)"
  [ "$g" = "$h" ] && echo "ok  $k unchanged" || { echo "FAIL $k CHANGED ($cur)"; ok=0; }
done < /tmp/stack-mig-snapshot.txt
[ $ok = 1 ]
'
```
Expected: ten `ok … unchanged` (5 DB/superpass + 4 virtual keys + bull key),
exit 0. **If any FAIL, stop** — a secret regenerated or a path is wrong;
investigate before recreate.

- [ ] **Step 3: Re-run helper + resolution tests against migrated layout**

Run: `bash lib/stacklib.test.sh && bash lib/profiles.test.sh`
Expected: both exit 0 (all `ok`).

---

### Task 12: Non-destructive recreate + live health verification

**Files:** none (operates the live `aitools` stack; volumes preserved)

- [ ] **Step 1: Recreate containers (keeps volumes; never `docker volume rm`)**

Run:
```bash
just down
just up 2>&1 | tail -30
```
Expected: `start complete`. (`just down` = `dc down --remove-orphans` +
machine stop — volumes untouched.)

- [ ] **Step 2: Stack health**

Run: `just status`
Expected: containers for the active profiles `Up`/`healthy`; pg, redis up;
no crash-looping provisioners.

- [ ] **Step 3: pg superuser auth intact against the existing volume**

Run:
```bash
bash -c '. lib/stacklib.sh; dc exec -T pg sh -lc "PGPASSWORD=\$POSTGRES_PASSWORD psql -U postgres -d postgres -tAc \"select 1\""'
```
Expected: `1` (superuser auth works → `POSTGRES_SUPERPASS` preserved & matches
the old volume).

- [ ] **Step 4: Per-service DB auth (litellm) + chatgpt token intact**

Run:
```bash
bash -c '. lib/stacklib.sh; dc exec -T litellm python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen(\"http://localhost:4000/health/liveliness\",timeout=5).status==200 else 1)" && echo LITELLM_OK'
diff <(shasum -a256 .stack/litellm/chatgpt/auth.json | cut -d" " -f1) <(grep -F LITELLM_DB_PASSWORD /dev/null; shasum -a256 services/litellm/chatgpt/auth.json 2>/dev/null | cut -d" " -f1) >/dev/null 2>&1 && echo AUTH_JSON_IDENTICAL || echo "AUTH_JSON: compare to backup if present"
```
Expected: `LITELLM_OK` (litellm reached its DB → `LITELLM_DB_PASSWORD`
preserved). auth.json hash equals the pre-move copy.

- [ ] **Step 5: Profile-resolution test against the live recreated stack**

Run: `bash lib/profiles.test.sh`
Expected: exit 0, all `ok`.

- [ ] **Step 6: Remove now-redundant bind-mount originals (post-green only)**

Run:
```bash
rm -f services/litellm/config.runtime.yaml services/honcho/config.runtime.toml services/cliproxyapi/config.runtime.yaml
rm -f services/litellm/chatgpt/auth.json; rmdir services/litellm/chatgpt 2>/dev/null || true
grep -rn "config.runtime" services/*/compose.yaml | grep -v '\.\./\.\./\.stack' || echo "ALL_BINDS_MIGRATED"
ls services/litellm/chatgpt 2>/dev/null && echo "WARN chatgpt dir remains" || echo "chatgpt dir gone"
```
Expected: `ALL_BINDS_MIGRATED`; `chatgpt dir gone`.

- [ ] **Step 7: Optional gitignore tidy + final commit**

In `.gitignore`, optionally remove the now-dead lines
`**/*.runtime.toml`, `**/*.runtime.yaml`, `**/*.runtime.json`, and
`services/litellm/chatgpt/auth.json` (keep `.stack/` and
`**/*.generated.env`). Then:
```bash
git add .gitignore 2>/dev/null || true
git status --porcelain
git diff --cached --stat
git commit -m "chore(gitignore): drop dead runtime-config/chatgpt ignores (state now in .stack/)" 2>/dev/null || echo "nothing to commit"
```

- [ ] **Step 8: Final state report**

Run: `just status && git log --oneline main..HEAD`
Expected: healthy stack; the feature-branch commits listed. Report to the
user that the stack is up and running on `feat/stack-config-deps-cleanup`,
pending their review before merge.

---

## Self-Review

**Spec coverage:**
- Spec Design A (substrate profiles, manifest, helpers, dc, justfile) →
  Tasks 2,3,4,5,6,8. ✓
- Spec Design B (.stack/<svc>/ layout, binds, render_template, build.sh,
  reconfigure, gitignore) → Tasks 7,12. ✓
- Migration runbook (gate, mv non-binds, cp binds, README git mv, hashes,
  build no-op, recreate) → Tasks 9,10,11,12. ✓
- Acceptance #1 pg rename → T2; #2 profiles → T5; #3 helpers/dc → T4,T6;
  #4 backends-first → T6; #5 resolution test → T8,T11,T12; #6 SUPERPASS
  preserved/layout → T9,T10,T11; #7 live health/auth → T12; #8 rabbitmq
  untouched by new consumers → satisfied by design (T3 manifest only). ✓
- Risks: SUPERPASS → T9 gate + T10 step1 (mv not delete) + T11 step2;
  incomplete audit → T8/T11/T12 resolution test; bind-moved-under-container
  → T10 copies, not moves; env-only substrate dep → T3 step1 audit grep. ✓
- **Pass-2 fix — ALL flat `*.generated.env` users repointed** (not just
  litellm/honcho/hindsight): firecrawl & camofox build.sh, litellm/preflight.sh
  (virtual-key minting), machines/hermes build.sh+start.sh → T7 step4 +
  sanity-grep. Virtual keys added to the T9 snapshot / T11 verify so a
  silent re-mint is caught. ✓

**Placeholder scan:** No TBD/TODO; every code/command step has concrete
content and expected output. Audit step (T3.1) gives an explicit decision
rule, not "figure it out". ✓

**Consistency:** Helper names `stack_required`/`stack_profiles`/
`stack_backends` and `_svc_requires` identical across T4, T6, T8, T11.
`.generated.env` (dot-prefixed) consistent in glob (T7.2) and migration
(T10.1) and gate (T9/T11). `services/pg` used everywhere after T2. ✓
