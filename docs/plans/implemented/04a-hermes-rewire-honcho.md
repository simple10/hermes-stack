> **SUPERSEDED by docs/plans/06-unified-stack-architecture.md** — kept for history only.

# 04a — Hermes → Dockerized Honcho rewire (clone `hermes` only)

> Operates ONLY on the clone VM **`hermes`** (the new prod). The original
> **`hermes-agent`** stays STOPPED/FROZEN — never touch it.
> Dockerized Honcho is up at `http://aitools-honcho-api.orb.local:8000`
> (Plan 03, verified; it routes LLM+embeddings via LiteLLM).

**Goal:** Point the clone's Hermes at the Dockerized Honcho, retire the
clone's now-redundant native Honcho+PG, verify the full
Hermes→Honcho(docker)→LiteLLM chain, and snapshot the (sanitized) Hermes
configs into this repo.

**Out of scope (deferred — needs user decision):** routing Hermes's *own
agent model* through LiteLLM (Plan 04b) — that requires choosing the agent
brain model; not done here.

## HARD CONSTRAINT
All `orb -m` here targets **`hermes`** (the clone). NEVER `hermes-agent`.
No `orb stop/start/clone` of `hermes-agent`.

---

### Task 1: Repoint honcho.json

- [ ] **Step 1:** Back up + show current:
```bash
orb -m hermes bash -lc 'cp ~/.hermes/honcho.json ~/.hermes/honcho.json.bak.predocker && python3 -c "import json;print(json.load(open(\"/home/joe/.hermes/honcho.json\")).get(\"baseUrl\"))"'
```
Expected: prints `http://localhost:8000` (current native).

- [ ] **Step 2:** Set baseUrl → Dockerized Honcho (preserve everything else,
  incl. `hosts.hermes` pinPeerName/peerName):
```bash
orb -m hermes bash -lc 'python3 - <<PY
import json
p="/home/joe/.hermes/honcho.json"; d=json.load(open(p))
d["baseUrl"]="http://aitools-honcho-api.orb.local:8000"
json.dump(d,open(p,"w"),indent=2)
print("baseUrl=",d["baseUrl"],"host.peerName=",d["hosts"]["hermes"].get("peerName"),"pinPeerName=",d["hosts"]["hermes"].get("pinPeerName"))
PY'
```
Expected: `baseUrl= http://aitools-honcho-api.orb.local:8000 host.peerName= joe pinPeerName= True`

### Task 2: Verify Hermes ↔ Dockerized Honcho

- [ ] **Step 1:** Reachability from the clone:
```bash
orb -m hermes bash -lc 'curl -sS -m6 http://aitools-honcho-api.orb.local:8000/health'
```
Expected: `{"status":"ok"}`

- [ ] **Step 2:** `hermes honcho status` now talks to the Docker backend:
```bash
orb -m hermes bash -lc 'timeout 40 /home/joe/.local/bin/hermes honcho status 2>&1 | grep -iE "host:|workspace|connection|OK|peer|representation" | head -15'
```
Expected: shows Honcho config + a successful connection (representation
fetched from the migrated `hermes` workspace).

### Task 3: Retire the clone's native Honcho + PG

> Data already migrated to `aitools-pg`. Disable (don't delete) the clone's
> native services so they don't run/boot; leave their data dormant as an
> in-clone safety copy.

- [ ] **Step 1:**
```bash
orb -m hermes bash -lc 'sudo systemctl disable --now honcho-api honcho-deriver && sudo systemctl disable --now postgresql && systemctl is-active honcho-api honcho-deriver postgresql 2>&1 | tr "\n" " "; echo'
```
Expected: `inactive inactive inactive` (all stopped+disabled).

- [ ] **Step 2:** Confirm `hermes-dashboard` still runs (it uses the rewired
  honcho.json now):
```bash
orb -m hermes bash -lc 'systemctl is-active hermes-dashboard 2>&1'
```
Expected: `active` (or note if absent — non-fatal).

### Task 4: End-to-end — Hermes → Docker Honcho → LiteLLM

- [ ] **Step 1:** Capture LiteLLM spend-log baseline:
```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
LLDB=$(grep ^LITELLM_DB_PASSWORD aitools-backends/.env|cut -d= -f2)
docker run --rm --network aitools-net -e PGPASSWORD="$LLDB" postgres:17 psql -h aitools-pg -U litellm -d litellm -tAc 'SELECT count(*) FROM "LiteLLM_SpendLogs";'
```
Note the number `N0`.

- [ ] **Step 2:** Drive a Hermes memory call (non-interactive) that forces
  Honcho usage from the clone:
```bash
orb -m hermes bash -lc 'timeout 90 /home/joe/.local/bin/hermes honcho status 2>&1 | tail -3'
```
(`hermes honcho status` fetches a peer representation = a Honcho dialectic/
LLM call through the Docker stack.) Expected: connection OK, representation
text shown.

- [ ] **Step 3:** Wait for LiteLLM async flush, re-check spend logs:
```bash
sleep 30
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
LLDB=$(grep ^LITELLM_DB_PASSWORD aitools-backends/.env|cut -d= -f2)
docker run --rm --network aitools-net -e PGPASSWORD="$LLDB" postgres:17 psql -h aitools-pg -U litellm -d litellm -tAc 'SELECT count(*) FROM "LiteLLM_SpendLogs";'
```
Expected: `> N0` — proves Hermes(clone) → Honcho(docker) → LiteLLM chain.

### Task 5: Sanitized config snapshot into the repo

- [ ] **Step 1:** Snapshot `config.yaml` + `honcho.json` with secrets
  redacted (NEVER snapshot `~/.hermes/.env`):
```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
mkdir -p hermes-config-snapshot
orb -m hermes bash -lc 'cat ~/.hermes/honcho.json' > hermes-config-snapshot/honcho.json
orb -m hermes bash -lc 'cat ~/.hermes/config.yaml' > hermes-config-snapshot/config.yaml
# Redact obvious secret-bearing values (api keys/tokens/passwords) in the snapshot:
python3 - <<'PY'
import re,glob
for f in glob.glob("hermes-config-snapshot/*"):
    s=open(f).read()
    s=re.sub(r'(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*["\']?[A-Za-z0-9._\-]{12,}["\']?',
             r'\1: <REDACTED>', s)
    s=re.sub(r'sk-[A-Za-z0-9._\-]{12,}', '<REDACTED-KEY>', s)
    open(f,"w").write(s)
print("redacted snapshot written")
PY
grep -riE 'sk-[A-Za-z0-9]{12}|api_key.*[A-Za-z0-9]{20}' hermes-config-snapshot/ && echo "STILL HAS SECRETS - STOP" || echo "snapshot clean"
```
Expected: `snapshot clean`. Manually eyeball both files; if any secret
remains, redact and re-check before committing.

- [ ] **Step 2:** Commit:
```bash
git add hermes-config-snapshot/ docs/plans/04a-hermes-rewire-honcho.md
git commit -m "feat(hermes): rewire clone to Dockerized Honcho + sanitized config snapshot"
```

---

## Acceptance criteria (verify ALL, paste evidence)

- Clone `hermes` `honcho.json` `baseUrl` = `http://aitools-honcho-api.orb.local:8000`; `hosts.hermes` (peerName/pinPeerName) preserved.
- `hermes honcho status` in the clone connects to the Dockerized Honcho and returns the migrated `hermes` workspace representation.
- Clone's native `honcho-api`/`honcho-deriver`/`postgresql` are `inactive` + disabled (won't boot).
- LiteLLM spend-log count increased after a Hermes-driven Honcho call (full Hermes→Honcho→LiteLLM chain proven).
- `hermes-config-snapshot/` committed, **no secrets** in it.
- `hermes-agent` never referenced; clone-only changes.

## Notes
- Plan 04b (deferred): route Hermes's agent model through LiteLLM — needs
  user's model choice + a LiteLLM model entry + `HERMES_VIRTUAL_KEY` in the
  clone's `config.yaml`.
