# 02 — aitools-services: LiteLLM Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development / executing-plans.
> Builds on Plan 01 (aitools-backends running, `aitools-net` external,
> `litellm` DB+role in `aitools-pg`). Verified facts used here:
> - LiteLLM official image proxies `voyage/voyage-4-lite` out of the box;
>   bare call → 1024; it translates OpenAI `dimensions`→Voyage
>   `output_dimension` (Phase-0 spike). No custom handler.
> - `litellm` DB role password lives in `aitools-backends/.env`
>   (`LITELLM_DB_PASSWORD`).

**Goal:** Stand up `aitools-litellm` (LiteLLM proxy, official
`litellm-database` image) as the first service of the `aitools-services`
compose: Postgres-backed keys/spend/**prompt logs** + UI, OpenRouter
GLM/Grok chat models + Voyage embedding model, master key, and virtual
keys for the `honcho` and `hermes` consumers.

**Architecture:** One container `aitools-litellm` on external `aitools-net`,
reaches `aitools-pg:5432/litellm` + `aitools-redis:6379` by alias. No host
ports — consumers use `aitools-litellm:4000` (containers) or
`aitools-litellm.orb.local:4000` (orb VM, verified Phase 0).

**Tech Stack:** `ghcr.io/berriai/litellm-database:main-latest`, Compose v2,
OrbStack engine.

---

### Task 1: Scaffold + pin image + confirm prompt-log flag

**Files:** Create `aitools-services/`, `aitools-services/litellm/`

- [ ] **Step 1:** `mkdir -p aitools-services/litellm`
- [ ] **Step 2:** Pull + record the image digest for reproducibility:

Run:
```bash
docker pull ghcr.io/berriai/litellm-database:main-latest && \
docker inspect ghcr.io/berriai/litellm-database:main-latest \
  --format '{{index .RepoDigests 0}}' | tee aitools-services/.litellm-image-digest
```
Expected: a `ghcr.io/berriai/litellm-database@sha256:...` line written to the file.

- [ ] **Step 3:** Confirm the prompt-logging setting name (known-stable
  feature; verify don't guess):

Run:
```bash
docker run --rm ghcr.io/berriai/litellm-database:main-latest \
  python -c "import litellm, inspect; print('store_prompts_in_spend_logs OK')" 2>/dev/null \
  || echo "verify general_settings.store_prompts_in_spend_logs in LiteLLM docs"
```
Expected: either confirmation, or proceed with `general_settings:
store_prompts_in_spend_logs: true` (the documented flag that writes
request+response into `LiteLLM_SpendLogs`, surfaced in the UI). Record what
was confirmed in a comment in `config.yaml`.

### Task 2: LiteLLM config

**Files:** Create `aitools-services/litellm/config.yaml`

- [ ] **Step 1:** Write it:

```yaml
# Models Honcho consumes (chat tiers via OpenRouter; embeddings via Voyage).
model_list:
  - model_name: glm-4.7-flash
    litellm_params:
      model: openrouter/z-ai/glm-4.7-flash
      api_key: os.environ/OPENROUTER_API_KEY
  - model_name: grok-4.3
    litellm_params:
      model: openrouter/x-ai/grok-4.3
      api_key: os.environ/OPENROUTER_API_KEY
  - model_name: glm-5
    litellm_params:
      model: openrouter/z-ai/glm-5
      api_key: os.environ/OPENROUTER_API_KEY
  - model_name: voyage-4-lite
    litellm_params:
      model: voyage/voyage-4-lite
      api_key: os.environ/VOYAGE_API_KEY

litellm_settings:
  drop_params: true        # tolerate caller params a provider doesn't take

general_settings:
  store_model_in_db: true
  store_prompts_in_spend_logs: true   # request+response in SpendLogs + UI
```

- [ ] **Step 2:** `git add aitools-services/litellm/config.yaml aitools-services/.litellm-image-digest docs/plans/02-aitools-litellm.md && git commit -m "feat(aitools-litellm): config + pinned image digest"`

### Task 3: Env (reuse Plan-01 litellm DB password)

**Files:** Create `aitools-services/.env.example`, `aitools-services/.env`

- [ ] **Step 1:** Write `aitools-services/.env.example`:

```env
LITELLM_MASTER_KEY=sk-change-me
LITELLM_DB_PASSWORD=must-match-aitools-backends
OPENROUTER_API_KEY=sk-or-v1-REPLACE
VOYAGE_API_KEY=pa-REPLACE
```

- [ ] **Step 2:** Build the real `.env` — DB password MUST equal the one
  Plan 01 generated:

```bash
cd aitools-services && \
LLDB=$(grep ^LITELLM_DB_PASSWORD ../aitools-backends/.env | cut -d= -f2) && \
{
  echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 24)"
  echo "LITELLM_DB_PASSWORD=$LLDB"
  echo "OPENROUTER_API_KEY=sk-or-v1-REPLACE-FROM-secrets.env"
  echo "VOYAGE_API_KEY=pa-REPLACE-FROM-secrets.env"
} > .env && echo "written; LITELLM_DB_PASSWORD matched from aitools-backends"
```
Expected: `written; ...`. (`**/.env` already gitignored from Plan 01.)

- [ ] **Step 3:** `git add aitools-services/.env.example && git commit -m "feat(aitools-litellm): env scaffold"`

### Task 4: Compose

**Files:** Create `aitools-services/compose.yaml`

- [ ] **Step 1:** Write it (Plan 03 will add honcho services to this file):

```yaml
name: aitools-services

services:
  aitools-litellm:
    image: ghcr.io/berriai/litellm-database:main-latest
    container_name: aitools-litellm
    restart: unless-stopped
    command: ["--config", "/app/config.yaml", "--port", "4000"]
    environment:
      LITELLM_MASTER_KEY: ${LITELLM_MASTER_KEY}
      DATABASE_URL: postgresql://litellm:${LITELLM_DB_PASSWORD}@aitools-pg:5432/litellm
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
      VOYAGE_API_KEY: ${VOYAGE_API_KEY}
      REDIS_URL: redis://aitools-redis:6379
    volumes:
      - ./litellm/config.yaml:/app/config.yaml:ro
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:4000/health/liveliness',timeout=3).status==200 else 1)\""]
      interval: 10s
      timeout: 6s
      retries: 18
    networks: [aitools-net]

networks:
  aitools-net:
    external: true
```

- [ ] **Step 2:** `cd aitools-services && docker compose --env-file .env config -q && echo OK` (expect `OK`)
- [ ] **Step 3:** `git add aitools-services/compose.yaml && git commit -m "feat(aitools-litellm): compose on aitools-net"`

### Task 5: Bring up + health (DB migrations auto-run)

- [ ] **Step 1:** `cd aitools-services && docker compose --env-file .env up -d`
- [ ] **Step 2:** Wait healthy (litellm-database runs Prisma migrations on
  first boot — allow generous time):

```bash
for i in $(seq 1 30); do h=$(docker inspect -f '{{.State.Health.Status}}' aitools-litellm 2>/dev/null); [ "$h" = healthy ] && echo "litellm healthy" && break; sleep 5; done
```
Expected: `litellm healthy`

- [ ] **Step 3:** Confirm migrations created LiteLLM tables in `litellm` DB:

```bash
docker run --rm --network aitools-net -e PGPASSWORD="$(grep ^LITELLM_DB_PASSWORD aitools-backends/.env|cut -d= -f2)" \
  postgres:17 psql -h aitools-pg -U litellm -d litellm -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'LiteLLM_%';"
```
Expected: a number `> 0`.

### Task 6: Virtual keys for honcho + hermes

- [ ] **Step 1:** Generate both keys via the admin API (master key), capture
  to a gitignored file:

```bash
MK=$(grep ^LITELLM_MASTER_KEY aitools-services/.env | cut -d= -f2)
gen(){ docker run --rm --network aitools-net curlimages/curl -s -X POST http://aitools-litellm:4000/key/generate \
  -H "Authorization: Bearer $MK" -H "Content-Type: application/json" \
  -d "{\"key_alias\":\"$1\",\"models\":[\"glm-4.7-flash\",\"grok-4.3\",\"glm-5\",\"voyage-4-lite\"]}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['key'])"; }
{ echo "HONCHO_VIRTUAL_KEY=$(gen honcho)"; echo "HERMES_VIRTUAL_KEY=$(gen hermes)"; } > aitools-services/keys.generated.env
cat aitools-services/keys.generated.env | sed -E 's/=(sk-[a-zA-Z0-9]{6}).*/=\1***/'
```
Expected: two `*_VIRTUAL_KEY=sk-...` lines (masked in output). Add
`aitools-services/keys.generated.env` to `.gitignore` (or rely on `**/.env`
— rename to `keys.generated.env` is NOT `.env`, so add an explicit
`**/keys.generated.env` ignore line) and commit the ignore change.

### Task 7: Verify chat + embedding + prompt logging

- [ ] **Step 1:** Chat via honcho virtual key:

```bash
HK=$(grep ^HONCHO_VIRTUAL_KEY aitools-services/keys.generated.env|cut -d= -f2)
docker run --rm --network aitools-net curlimages/curl -s -X POST http://aitools-litellm:4000/v1/chat/completions \
  -H "Authorization: Bearer $HK" -H "Content-Type: application/json" \
  -d '{"model":"glm-4.7-flash","messages":[{"role":"user","content":"reply with: ok"}],"max_tokens":5}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('CHAT', d['choices'][0]['message']['content'])"
```
Expected: `CHAT ok` (or similar non-error content).

- [ ] **Step 2:** Embedding via honcho virtual key (bare call = Honcho's
  `dimensions_mode=never` shape):

```bash
docker run --rm --network aitools-net curlimages/curl -s -X POST http://aitools-litellm:4000/v1/embeddings \
  -H "Authorization: Bearer $HK" -H "Content-Type: application/json" \
  -d '{"model":"voyage-4-lite","input":"hello"}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('EMB len', len(d['data'][0]['embedding']))"
```
Expected: `EMB len 1024`.

- [ ] **Step 3:** Prompt logging persisted:

```bash
docker run --rm --network aitools-net -e PGPASSWORD="$(grep ^LITELLM_DB_PASSWORD aitools-backends/.env|cut -d= -f2)" \
  postgres:17 psql -h aitools-pg -U litellm -d litellm -tAc \
  "SELECT count(*) FROM \"LiteLLM_SpendLogs\";"
```
Expected: `> 0` (the chat+embedding calls logged). If 0, check the
`store_prompts_in_spend_logs` setting name via `docker logs aitools-litellm`
and the LiteLLM docs, correct `config.yaml`, `docker compose up -d
--force-recreate aitools-litellm`, redo Steps 1–3.

- [ ] **Step 4 (read-only, allowed):** orb VM can reach LiteLLM for Phase 4:

```bash
orb -m hermes-agent bash -lc 'curl -sS -m6 -o /dev/null -w "%{http_code}\n" http://aitools-litellm.orb.local:4000/health/liveliness'
```
Expected: `200`. (Pure reachability check from the VM — does not modify
`hermes-agent`.)

- [ ] **Step 5:** `git add docs/plans/02-aitools-litellm.md && git commit -m "feat(aitools-litellm): verified chat+embedding+spendlog"`

---

## Acceptance criteria (verify ALL, paste evidence)

- `aitools-litellm` container `healthy`.
- `LiteLLM_*` tables exist in the `litellm` DB (migrations ran).
- Chat completion through the `honcho` virtual key returns content.
- Embedding through the virtual key returns a **1024**-length vector
  (bare call, no `dimensions`).
- `LiteLLM_SpendLogs` row count `> 0` after the test calls (prompt logging
  active).
- `aitools-litellm.orb.local:4000/health/liveliness` → 200 from the orb VM.
- Two virtual keys (`honcho`, `hermes`) generated and stored in
  `aitools-services/keys.generated.env` (gitignored, not committed).

## Notes for Plan 03 / 04

- Honcho (Plan 03) points model + embedding `base_url` →
  `http://aitools-litellm:4000` (container-to-container), `api_key` =
  `HONCHO_VIRTUAL_KEY`. Honcho model names map to litellm `model_name`s:
  deriver/summary/dialectic-min/low → `glm-4.7-flash`; dialectic med/high →
  `grok-4.3`; dialectic max + dream → `glm-5`; embedding → `voyage-4-lite`.
- Hermes (Plan 04) agent model → `http://aitools-litellm.orb.local:4000`,
  `api_key` = `HERMES_VIRTUAL_KEY`.
- Honcho keeps `dimensions_mode="never"` — bare embedding call → 1024
  (verified). LiteLLM also handles explicit `dimensions` if ever sent.

## HARD CONSTRAINT

Do not modify/start/stop/clone the `hermes-agent` orb VM. Only the Step 4
read-only `curl` from it is allowed.
