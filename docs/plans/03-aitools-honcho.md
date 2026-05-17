# 03 — aitools-services: Honcho Implementation Plan

> Builds on Plan 01 (aitools-pg/redis, `honcho` DB+role, `HONCHO_DB_PASSWORD`
> in `aitools-backends/.env`), Plan 02 (aitools-litellm up; virtual keys in
> `aitools-services/keys.generated.env` → `HONCHO_VIRTUAL_KEY`), Phase 1b
> (clone `hermes` running with native Honcho/PG = migration source;
> `hermes-agent` stopped/frozen — NEVER touch it).

**Goal:** Run Honcho (built from pinned source) as `aitools-honcho-api` +
`aitools-honcho-deriver` in the `aitools-services` compose, DB →
`aitools-pg/honcho`, cache → `aitools-redis`, all model+embedding traffic
→ `aitools-litellm` (honcho virtual key), and migrate the clone `hermes`'s
repopulated Honcho data into `aitools-pg/honcho` (fresh-start fallback).

**Tech Stack:** plastic-labs/honcho @ `8fcbb54` (built from source — no
published image), Compose v2, OrbStack.

## HARD CONSTRAINT
Never modify/start/stop the **`hermes-agent`** VM. The migration source is
the **clone `hermes`** (running) — reading via `pg_dump` from `hermes` is
fine. `hermes-agent` stays stopped/untouched.

---

### Task 1: Pin & fetch Honcho source

- [ ] **Step 1:** Confirm the pinned commit matches the clone's Honcho:
```bash
orb -m hermes bash -lc 'cd ~/honcho && git rev-parse HEAD'
```
Record the SHA (expected `8fcbb54...`). Use that exact SHA below as `PIN`.

- [ ] **Step 2:** Clone source into a gitignored build context:
```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git clone https://github.com/plastic-labs/honcho aitools-services/honcho-src
cd aitools-services/honcho-src && git checkout <PIN> && git rev-parse HEAD
```
Expected: prints `<PIN>`.

- [ ] **Step 3:** Gitignore the vendored source (don't nest a repo):
add `aitools-services/honcho-src/` to `hermes-stack/.gitignore`; also
`rm -rf aitools-services/honcho-src/.git`. Commit the ignore line.

### Task 2: Honcho config (derived from the clone, routed via LiteLLM)

- [ ] **Step 1:** Pull the clone's working config as the base:
```bash
mkdir -p aitools-services/honcho
orb -m hermes bash -lc 'cat ~/honcho/config.toml' > aitools-services/honcho/config.toml
```

- [ ] **Step 2:** Transform it for the Dockerized, LiteLLM-routed stack.
Apply these exact changes (python below):
- every `[*.model_config.overrides] base_url` → `http://aitools-litellm:4000`
- model ids → LiteLLM model_names: `z-ai/glm-4.7-flash`→`glm-4.7-flash`,
  `x-ai/grok-4.3`→`grok-4.3`, `z-ai/glm-5`→`glm-5`,
  `voyage-4-lite` stays `voyage-4-lite`, any `openai/`-prefixed → strip
  prefix to the matching litellm name
- `[db] CONNECTION_URI` → `postgresql+psycopg://honcho:$HONCHO_DB_PASSWORD@aitools-pg:5432/honcho`
- keep: `[embedding] VECTOR_DIMENSIONS = 1024`, embedding
  `dimensions_mode = "never"`, `[app] EMBED_MESSAGES = true`
- `[cache] ENABLED = true`, add `URL = "redis://aitools-redis:6379/0?suppress=true"`

```bash
cd aitools-services && \
HDB=$(grep ^HONCHO_DB_PASSWORD ../aitools-backends/.env|cut -d= -f2) && \
python3 - "$HDB" <<'PY'
import re,sys
HDB=sys.argv[1]
p="honcho/config.toml"; s=open(p).read().splitlines(); out=[]; cur=None
mmap={"z-ai/glm-4.7-flash":"glm-4.7-flash","x-ai/grok-4.3":"grok-4.3",
      "z-ai/glm-5":"glm-5","openai/gpt-5.4-mini":"glm-4.7-flash"}
for ln in s:
    t=ln.strip()
    m=re.match(r"^\[([^\]]+)\]\s*$",t)
    if m and not t.startswith("#"): cur=m.group(1); out.append(ln); continue
    if cur and cur.endswith("overrides") and t.startswith("base_url"):
        out.append('base_url = "http://aitools-litellm:4000"'); continue
    if cur and cur.endswith("model_config") and t.startswith("model"):
        mv=re.match(r'^model\s*=\s*"([^"]+)"',t).group(1)
        out.append(f'model = "{mmap.get(mv, mv.split("/")[-1] if "/" in mv else mv)}"'); continue
    if cur=="db" and t.startswith("CONNECTION_URI"):
        out.append(f'CONNECTION_URI = "postgresql+psycopg://honcho:{HDB}@aitools-pg:5432/honcho"'); continue
    if cur=="cache" and t.startswith("ENABLED"): out.append("ENABLED = true"); continue
    if cur=="cache" and t.startswith("URL"):
        out.append('URL = "redis://aitools-redis:6379/0?suppress=true"'); continue
    out.append(ln)
open(p,"w").write("\n".join(out)+"\n")
print("transformed")
PY
```
Expected: `transformed`. Then sanity-check: `python3 -c "import tomllib;d=tomllib.load(open('honcho/config.toml','rb'));print(d['embedding']['VECTOR_DIMENSIONS'], d['embedding']['model_config']['model'], d['embedding']['model_config'].get('dimensions_mode'), d['deriver']['model_config']['model'], d['deriver']['model_config']['overrides']['base_url'])"` → expect `1024 voyage-4-lite never glm-4.7-flash http://aitools-litellm:4000`. If `[cache] URL` line was absent to replace, add it under `[cache]` manually.

- [ ] **Step 3:** Add Honcho secrets to `aitools-services/.env`:
```bash
cd aitools-services && \
echo "HONCHO_DB_PASSWORD=$(grep ^HONCHO_DB_PASSWORD ../aitools-backends/.env|cut -d= -f2)" >> .env && \
echo "HONCHO_VIRTUAL_KEY=$(grep ^HONCHO_VIRTUAL_KEY keys.generated.env|cut -d= -f2)" >> .env && \
echo "appended"
```
In `config.toml`, ensure `[llm] OPENAI_API_KEY` (or the per-module
`overrides.api_key_env`) resolves to the LiteLLM virtual key: set each
model_config `overrides.api_key_env = "HONCHO_VIRTUAL_KEY"` (add the line
under each `[*.model_config.overrides]` if absent — transport stays
`openai`; LiteLLM is OpenAI-compatible). Re-run the tomllib sanity check.

- [ ] **Step 4:** `git add aitools-services/honcho/config.toml .gitignore docs/plans/03-aitools-honcho.md && git commit -m "feat(aitools-honcho): litellm-routed config"`

### Task 3: Extend aitools-services compose with Honcho

- [ ] **Step 1:** Add to `aitools-services/compose.yaml` under `services:`
(keep existing `aitools-litellm`):

```yaml
  aitools-honcho-api:
    build: { context: ./honcho-src, dockerfile: Dockerfile }
    container_name: aitools-honcho-api
    restart: unless-stopped
    entrypoint: ["sh", "docker/entrypoint.sh"]
    environment:
      DB_CONNECTION_URI: postgresql+psycopg://honcho:${HONCHO_DB_PASSWORD}@aitools-pg:5432/honcho
      CACHE_URL: redis://aitools-redis:6379/0?suppress=true
      CACHE_ENABLED: "true"
      HONCHO_VIRTUAL_KEY: ${HONCHO_VIRTUAL_KEY}
    volumes:
      - ./honcho/config.toml:/app/config.toml:ro
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health',timeout=3).status==200 else 1)\""]
      interval: 10s
      timeout: 6s
      retries: 30
    networks: [aitools-net]

  aitools-honcho-deriver:
    build: { context: ./honcho-src, dockerfile: Dockerfile }
    container_name: aitools-honcho-deriver
    restart: unless-stopped
    entrypoint: ["/app/.venv/bin/python", "-m", "src.deriver"]
    environment:
      DB_CONNECTION_URI: postgresql+psycopg://honcho:${HONCHO_DB_PASSWORD}@aitools-pg:5432/honcho
      CACHE_URL: redis://aitools-redis:6379/0?suppress=true
      CACHE_ENABLED: "true"
      HONCHO_VIRTUAL_KEY: ${HONCHO_VIRTUAL_KEY}
    volumes:
      - ./honcho/config.toml:/app/config.toml:ro
    networks: [aitools-net]
```

- [ ] **Step 2:** `cd aitools-services && docker compose --env-file .env config -q && echo OK`
- [ ] **Step 3:** Build (no up yet — migration first): `docker compose --env-file .env build aitools-honcho-api aitools-honcho-deriver` (expect success). Commit compose.

### Task 4: Migrate data (clone `hermes` → aitools-pg/honcho), with fallback

- [ ] **Step 1:** Dump the clone's native Honcho DB and restore into
  `aitools-pg/honcho` (clone `hermes` reaches aitools-pg via
  `aitools-pg.orb.local`):
```bash
HDB=$(grep ^HONCHO_DB_PASSWORD aitools-backends/.env|cut -d= -f2)
orb -m hermes bash -lc "PGPASSWORD=postgres pg_dump -h 127.0.0.1 -U postgres -d postgres --no-owner --no-privileges -Fc" > /tmp/honcho_src.dump
ls -la /tmp/honcho_src.dump
docker run --rm --network aitools-net -v /tmp/honcho_src.dump:/d.dump:ro \
  -e PGPASSWORD="$HDB" postgres:17 \
  pg_restore --no-owner --no-privileges --role=honcho -h aitools-pg -U honcho -d honcho --clean --if-exists /d.dump 2>&1 | tail -20 || echo "RESTORE_HAD_WARNINGS"
```

- [ ] **Step 2:** Verify migration:
```bash
docker run --rm --network aitools-net -e PGPASSWORD="$HDB" postgres:17 psql -h aitools-pg -U honcho -d honcho -tAc \
 "SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attname='embedding' AND attrelid::regclass::text IN ('documents','message_embeddings');
  SELECT 'alembic', version_num FROM alembic_version;
  SELECT 'msgcnt', count(*) FROM messages;"
```
Expected: `vector(1024)` (x2), an `alembic|<rev>` row, `msgcnt|<n>`.

- [ ] **Step 3 (FALLBACK if Step 2 not vector(1024) or restore failed):**
fresh start —
```bash
docker run --rm --network aitools-net -e PGPASSWORD="$HDB" postgres:17 psql -h aitools-pg -U honcho -d honcho -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector;"
cd aitools-services && docker compose --env-file .env run --rm aitools-honcho-api bash -lc "uv run alembic upgrade head && uv run python scripts/configure_embeddings.py --yes"
```
Re-run Step 2's dim check → must be `vector(1024)`.

### Task 5: Bring up Honcho

- [ ] **Step 1:** `cd aitools-services && docker compose --env-file .env up -d aitools-honcho-api aitools-honcho-deriver`
- [ ] **Step 2:** Wait healthy:
```bash
for i in $(seq 1 36); do h=$(docker inspect -f '{{.State.Health.Status}}' aitools-honcho-api 2>/dev/null); [ "$h" = healthy ] && echo "honcho-api healthy" && break; sleep 5; done
```
- [ ] **Step 3:** Confirm boot embedding_validator passed (no crash):
`docker logs aitools-honcho-api 2>&1 | grep -iE "embedding|validator|dimension|Application startup complete" | tail -5` — expect "Application startup complete", no dim-mismatch crash.

### Task 6: End-to-end via LiteLLM

- [ ] **Step 1:** Ingest + search + dialectic (new workspace):
```bash
docker run --rm --network aitools-net curlimages/curl -s -X POST http://aitools-honcho-api:8000/v3/workspaces -H 'Content-Type: application/json' -d '{"id":"e2e"}' >/dev/null
docker run --rm --network aitools-net curlimages/curl -s -X POST http://aitools-honcho-api:8000/v3/workspaces/e2e/peers -H 'Content-Type: application/json' -d '{"id":"joe"}' >/dev/null
docker run --rm --network aitools-net curlimages/curl -s -X POST http://aitools-honcho-api:8000/v3/workspaces/e2e/sessions -H 'Content-Type: application/json' -d '{"id":"s1","peers":{"joe":{}}}' >/dev/null
docker run --rm --network aitools-net curlimages/curl -s -X POST http://aitools-honcho-api:8000/v3/workspaces/e2e/sessions/s1/messages -H 'Content-Type: application/json' -d '{"messages":[{"peer_id":"joe","content":"I run my AI stack on OrbStack with LiteLLM and Voyage embeddings."}]}'
sleep 30
docker run --rm --network aitools-net curlimages/curl -s -X POST http://aitools-honcho-api:8000/v3/workspaces/e2e/sessions/s1/search -H 'Content-Type: application/json' -d '{"query":"what does the embedding stack use"}'
docker run --rm --network aitools-net curlimages/curl -s -X POST http://aitools-honcho-api:8000/v3/workspaces/e2e/peers/joe/chat -H 'Content-Type: application/json' -d '{"query":"what does this person run their stack on?","session_id":"s1","reasoning_level":"low"}'
```
Expected: search returns the message; chat returns a synthesized answer.

- [ ] **Step 2:** Confirm Honcho→LiteLLM path: stored 1024 vector + a new
  LiteLLM spend-log row:
```bash
HDB=$(grep ^HONCHO_DB_PASSWORD aitools-backends/.env|cut -d= -f2)
docker run --rm --network aitools-net -e PGPASSWORD="$HDB" postgres:17 psql -h aitools-pg -U honcho -d honcho -tAc "SELECT vector_dims(embedding) FROM message_embeddings WHERE embedding IS NOT NULL ORDER BY 1 DESC LIMIT 1;"
LLDB=$(grep ^LITELLM_DB_PASSWORD aitools-backends/.env|cut -d= -f2)
docker run --rm --network aitools-net -e PGPASSWORD="$LLDB" postgres:17 psql -h aitools-pg -U litellm -d litellm -tAc "SELECT count(*) FROM \"LiteLLM_SpendLogs\";"
```
Expected: `1024`; spend-log count higher than Plan 02's (Honcho calls flowed through LiteLLM).

- [ ] **Step 3:** Clean the e2e workspace (delete sessions then workspace),
  commit: `git add docs/plans/03-aitools-honcho.md && git commit -m "feat(aitools-honcho): up, migrated, e2e via litellm verified"`

---

## Acceptance criteria (verify ALL, paste evidence)

- `aitools-honcho-api` healthy; deriver running; boot embedding_validator
  passed (no dim crash).
- `documents.embedding` & `message_embeddings.embedding` are `vector(1024)`
  in `aitools-pg/honcho` (migrated or fresh).
- End-to-end: ingest → search returns the message → dialectic answers.
- A freshly stored `message_embeddings` vector has dim **1024**.
- `LiteLLM_SpendLogs` grew (Honcho's LLM+embedding calls went through
  LiteLLM, not direct to OpenRouter/Voyage).
- `hermes-agent` still stopped & unmodified; clone `hermes` untouched
  except read-only `pg_dump`.

## Notes for Plan 04
- Honcho reachable at `http://aitools-honcho-api.orb.local:8000` from the
  clone `hermes` VM (Phase-0 verified pattern) — used to rewire Hermes'
  `honcho.json` baseUrl.
