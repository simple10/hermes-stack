# Joe's Local Setup — OrbStack + Hermes + Honcho

Personal runbook for the `hermes-agent` OrbStack machine and the services
running inside it. Not canonical project docs.

Last verified: 2026-05-15.

---

## Topology

Everything runs inside a single OrbStack **Linux machine** named
`hermes-agent` (Ubuntu 25.10, aarch64). Hermes and Honcho are installed
natively in that machine (no Docker) and run as **systemd services**, so they
survive `orb` exec sessions, machine reboots, and crash with auto-restart.

```
Mac browser/CLI ──> hermes-agent.orb.local ──(OrbStack proxy)──> orb machine
                                                                  ├─ hermes-dashboard  :9119
                                                                  ├─ honcho-api        :8000
                                                                  ├─ honcho-deriver    (worker)
                                                                  └─ postgresql        :5432 (internal)
```

There is a *separate, older* Docker-based attempt in this repo
(`docker-compose.override.yml`, `.env` with `HERMES_UID`/`HERMES_GID`). That
is **not** the orb setup and is not needed for the workflow below. The orb is
the canonical environment.

---

## Quick access (from the Mac)

| Service | URL | Notes |
|---------|-----|-------|
| Hermes dashboard | <http://hermes-agent.orb.local:9119> | Web UI |
| Honcho API health | <http://hermes-agent.orb.local:8000/health> | `{"status":"ok"}` |
| Honcho API docs | <http://hermes-agent.orb.local:8000/docs> | FastAPI Swagger UI |

API root `:8000/` returns 404 by design — use `/health` or `/docs`.

---

## Entering the machine

```sh
orb -m hermes-agent                 # interactive shell (user: joe)
orb -m hermes-agent <command>       # one-off command (NO `--` separator)
orb list                            # list machines
orb info hermes-agent               # machine details
```

`orb -m hermes-agent -- cmd` does **not** work — `orb run` rejects `--`.
Just use `orb -m hermes-agent cmd`.

---

## Services

All are systemd **system** units, `User=joe`, `Restart=on-failure`, enabled
at boot.

| Unit | Command | Port |
|------|---------|------|
| `hermes-dashboard.service` | `hermes dashboard --host 0.0.0.0 --port 9119 --no-open --insecure` | 9119 |
| `honcho-api.service` | `uv run fastapi run src/main.py --host 0.0.0.0 --port 8000` | 8000 |
| `honcho-deriver.service` | `uv run python -m src.deriver` | — |
| `postgresql.service` | (stock Ubuntu PG 17) | 5432 (localhost only) |

Unit files: `/etc/systemd/system/{hermes-dashboard,honcho-api,honcho-deriver}.service`

### Management

```sh
# status / health
orb -m hermes-agent sudo systemctl status hermes-dashboard honcho-api honcho-deriver

# restart one
orb -m hermes-agent sudo systemctl restart honcho-deriver

# follow logs
orb -m hermes-agent sudo journalctl -u hermes-dashboard -f
orb -m hermes-agent sudo journalctl -u honcho-api -n 100 --no-pager

# stop / start
orb -m hermes-agent sudo systemctl stop hermes-dashboard
orb -m hermes-agent sudo systemctl start hermes-dashboard

# disable autostart (if ever needed)
orb -m hermes-agent sudo systemctl disable hermes-dashboard
```

---

## Hermes

- Version: v0.13.0. Binary: `/home/joe/.local/bin/hermes`.
- Code: `/home/joe/.hermes/hermes-agent`. Config/data: `/home/joe/.hermes/`.

### Chat (interactive TUI)

```sh
orb -m hermes-agent           # then inside:
hermes
```

### First-time / API key setup

The installer skipped the setup wizard (no TTY). Run it once:

```sh
orb -m hermes-agent
hermes setup                  # API keys, model, gateway choice
```

Config lives at `/home/joe/.hermes/config.yaml`, keys at
`/home/joe/.hermes/.env`.

### Dashboard

Already running as a service at <http://hermes-agent.orb.local:9119>.
The `--insecure` flag is required because the dashboard hardcodes a
loopback-only bind guard and refuses `0.0.0.0` otherwise. Safe here: the
orb's `0.0.0.0` is reachable only by the Mac (via OrbStack's proxy) and
co-located OrbStack VMs — **not** the LAN or internet.

### Update Hermes

```sh
orb -m hermes-agent hermes update
orb -m hermes-agent sudo systemctl restart hermes-dashboard
```

---

## Honcho (Plastic Labs — agent memory)

- Repo: `/home/joe/honcho` (commit `8fcbb54`, server 3.x).
- Python deps via `uv` (venv at `/home/joe/honcho/.venv`).
- Config split: **`config.toml`** holds all structured config (built from
  `config.toml.example`); **`.env`** holds only the secret. Precedence is
  `env > .env > config.toml > defaults`.

### LLM provider: OpenRouter (all modules)

Honcho's recommended template defaults are kept as-is. The only changes vs
the stock `config.toml.example` are: every `*.model_config` model id is
prefixed `openai/` (OpenRouter requires `provider/model` slugs — same models,
not a swap) and given an `overrides.base_url` pointing at OpenRouter.

`/home/joe/honcho/.env` (entire file — just the secret):

```env
LLM_OPENAI_API_KEY=sk-or-v1-…ff2b      # OpenRouter key
```

`config.toml` model wiring (identical block on deriver, summary, all 5
`dialectic.levels.*`, `dream.deduction`/`induction`, embedding):

```toml
[deriver.model_config]
transport = "openai"
model = "openai/gpt-5.4-mini"            # embedding: NOW Voyage — see "Embeddings: Voyage" below
[deriver.model_config.overrides]
base_url = "https://openrouter.ai/api/v1"
```

Verified end-to-end 2026-05-15: dialectic (text-gen) returns 200 through
OpenRouter; no deriver errors. (Embeddings later moved off OpenRouter to
Voyage — see "Embeddings: Voyage" below; this line is text-gen only now.)

### What changed vs the earlier all-`.env` attempt

| Aspect | Before (full `.env`) | Now (`config.toml` + 1-line `.env`) |
|--------|----------------------|--------------------------------------|
| Text-gen model | `google/gemini-2.5-flash` (my pick) | ⚠️ SUPERSEDED → now **tiered** (glm-4.7-flash / grok-4.3 / glm-5), see "LLM model tiering" |
| Embedding model | `openai/text-embedding-3-small` | ⚠️ SUPERSEDED → now `voyage-4-lite` @1024, see "Embeddings: Voyage" |
| Config location | ~30 lines of `FOO__BAR__BAZ=` env vars | readable TOML; `.env` is 1 line |
| DB connection | `DB_CONNECTION_URI` in `.env` | `[db] CONNECTION_URI` in `config.toml` (same value; ⚠️ password now in non-secret file — fine for local-only orb DB) |
| Global `LLM_OPENAI_BASE_URL` | set (redundant) | dropped — per-module `overrides.base_url` is authoritative |
| `EMBED_MESSAGES` | implicit default `true` | explicit `true` (no behavior change) |
| Embedding sizes | code defaults | explicit recommended defaults: `VECTOR_DIMENSIONS=1536`, `MAX_INPUT_TOKENS=8192`, `MAX_TOKENS_PER_REQUEST=300000` (matches pgvector 1536-dim schema) |
| Everything else | implicit defaults | explicit Honcho recommended defaults (token budgets, dialectic per-level tool iterations, dream thresholds, summary cadence, pool sizes) — same effective behavior, now auditable |

Features ON (template defaults): deriver, peer_card, summary, dream,
embeddings/semantic-search. Intentionally left at default-**off** (flip in
`config.toml` if wanted): `[dream.surprisal]` (experimental sampling),
`[sentry]`, `[metrics]`, `[telemetry]`, `[cache]` (need backing infra /
privacy). Backups of prior `.env` at `~/honcho/.env.bak.*`.

### Editing config from the Mac

```sh
# Direct SSH
ssh-add ~/.orbstack/ssh/id_ed25519
ssh ssh hermes-agent@orb

# Use ssh-remote to edit files in a linux orb in IDEs
code --remote ssh-remote+hermes-agent@orb /home/joe/honcho

# App accessing ~/Orbstack paths require full disk or network volumes access in macOS System Settings > Privacy
# e.g. cursor needs full disk access to edit ~/OrbStack/hermes-agent/home/joe/ files
open ~/OrbStack/hermes-agent/home/joe/honcho/config.toml
cursor ~/OrbStack/hermes-agent/home/joe/honcho/config.toml
```

After any `config.toml` / `.env` change:

```sh
orb -m hermes-agent sudo systemctl restart honcho-api honcho-deriver
```

### Use from an SDK

```python
from honcho import Honcho
honcho = Honcho(workspace_id="my-app", base_url="http://hermes-agent.orb.local:8000")
# inside the orb, base_url="http://localhost:8000"
```

### Update Honcho

```sh
orb -m hermes-agent bash -lc 'cd ~/honcho && git pull && uv sync && uv run alembic upgrade head'
orb -m hermes-agent sudo systemctl restart honcho-api honcho-deriver
```

### Honcho Hermes Config

```bash
  Config written to /home/joe/.hermes/honcho.json
  Memory provider set to 'honcho' in config.yaml
  Testing connection... OK

  Honcho is ready.
  Session:   hermes-agent
  Workspace: hermes
  User:      joe
  AI peer:   hermes
  Observe:   directional
  Frequency: async
  Recall:    hybrid
  Sessions:  per-session

  Honcho tools available in chat:
    honcho_context   -- session context: summary, representation, card, messages
    honcho_search    -- semantic search over history
    honcho_profile   -- peer card, key facts
    honcho_reasoning -- ask Honcho a question, synthesized answer
    honcho_conclude  -- persist a user fact to memory

  Other commands:
    hermes honcho status     -- show full config
    hermes honcho mode       -- change recall/observation mode
    hermes honcho tokens     -- tune context and dialectic budgets
    hermes honcho peer       -- update peer names
    hermes honcho map <name> -- map this directory to a session name
```

### Memory model: built-in + Honcho (both active)

Two systems run in parallel — not either/or:

- **Built-in** (`~/.hermes/memories/{MEMORY.md,USER.md}`) — always on,
  cannot be disabled. Inspect: `cat`, or `hermes memory status`.
- **Honcho** (the active external provider, workspace `hermes`) — the rich
  LLM-derived store. Inspect: `hermes honcho status`, or the API
  (`POST /v3/workspaces/hermes/conclusions/list`,
  `POST /v3/workspaces/hermes/peers/joe/representation`,
  `POST /v3/workspaces/hermes/peers/joe/chat`).

### Peer pinning (fixes channel memory fragmentation)

By default the Telegram gateway attributes memory to the sender's raw
Telegram ID, forking memory: TUI → peer `joe`, Telegram → peer
`8090744783`. Fix applied (2026-05-16):

```json
// ~/.hermes/honcho.json  →  hosts.hermes
"pinPeerName": true
```

`pinPeerName: true` makes the configured `peerName` ("joe") win over any
gateway-supplied runtime identity, so every channel unifies onto `joe`.
Correct here only because this is single-user (default `false` is for
multi-user). Read by the Hermes agent process at startup (not the Honcho
server) — takes effect when the gateway next starts; no service restart.

**Cleanup done (#3, clean slate):** deleted the 5 `agent-main-telegram-*-8090744783-*`
sessions; the `8090744783` representation is now empty. The peer *name*
still lingers in the peer list (Honcho has no hard peer-delete API) but is
an inert shell — zero memory, and pinning prevents any future writes to it.
Kept: `hermes-agent`, `Greeting-Joe`, the two `20260515_*` TUI sessions.
Config backup: `~/.hermes/honcho.json.bak.*`.

**Verification checkpoint (pending live gateway):** after the gateway is
running, the first Telegram message should attribute to `joe` and must
**not** recreate an `8090744783` peer/session.

### LLM model tiering (2026-05-16)

**Supersedes** the uniform `openai/gpt-5.4-mini` mentions above. All via
OpenRouter (`transport=openai`, `overrides.base_url=openrouter.ai/api/v1`,
the OpenRouter key in `.env`). Tiering follows the validated
`elkimek/honcho-self-hosted` recipe, current OpenRouter IDs:

| `config.toml` block(s) | Model | Role |
|------------------------|-------|------|
| `[deriver.model_config]`, `[summary.model_config]`, `[dialectic.levels.minimal/low.model_config]` | `z-ai/glm-4.7-flash` | high-volume workhorse — cheap, tool-calling-tuned |
| `[dialectic.levels.medium/high.model_config]` | `x-ai/grok-4.3` | mid tier (repo's `grok-4.1-fast` is retired — substituted) |
| `[dialectic.levels.max.model_config]`, `[dream.deduction_model_config]`, `[dream.induction_model_config]` | `z-ai/glm-5` | rare/high-value: hardest queries + dream consolidation |

Embedding is **not** part of this — it's Voyage (next section), separate
provider/key.

`glm-5` 200k context is sufficient: Honcho caps dialectic input at
`MAX_INPUT_TOKENS=100000` and dream history at `HISTORY_TOKEN_LIMIT=16384`,
both well under 200k. If ever tight, the lever is those caps, not the model.

**Verified 2026-05-16:** clean boot (no config/validator errors); e2e
dialectic-low + deriver (both glm-4.7-flash) + Voyage embed/search all
work via OpenRouter, no errors. grok-4.3 / glm-5 tiers are config-loaded
and their OpenRouter IDs were confirmed to exist; they only fire on
escalation/dream so weren't force-tested but ride the same proven
transport. Backup: `config.toml.bak.tiering`.

### Embeddings: Voyage `voyage-4-lite` @ 1024 (2026-05-16)

**Supersedes** the OpenRouter `text-embedding-3-small` mentions above. Only
the embedding module changed; LLM modules still go through OpenRouter.

`~/honcho/config.toml`:

```toml
[embedding]
VECTOR_DIMENSIONS = 1024

[embedding.model_config]
transport = "openai"
model = "voyage-4-lite"
dimensions_mode = "never"          # ← critical, see below
[embedding.model_config.overrides]
base_url = "https://api.voyageai.com/v1"
api_key_env = "VOYAGE_API_KEY"
```

`~/honcho/.env` gained `VOYAGE_API_KEY=pa-…` (Voyage is **not** on
OpenRouter — separate provider + key; LLM modules still use the OpenRouter
key).

**The `dimensions_mode = "never"` crux:** Voyage's API rejects the
OpenAI-style `dimensions=` param with HTTP 400 (`"Argument 'dimensions' is
not supported"`). `never` makes Honcho send a bare call; voyage-4-lite then
returns its **native default 1024**, which matches `VECTOR_DIMENSIONS` and
passes Honcho's response-dim validator. Using `always`/`auto` here would
400 every embedding. (This is the opposite of Honcho's text-embedding-3
guidance — that's OpenAI-specific.)

**Constraint:** locked to Voyage's default 1024. Honcho can't send
`output_dimension` (Voyage's native param), so non-default dims or a
read/write model split (4-large writes / 4-lite queries) would need a
translating proxy — future work.

**How it was applied (official path, no source patching):** per Honcho's
`docs/v3/contributing/changing-embeddings` — dim/model changes are not
in-place; the supported path is rebuild. Sequence used:
`config.toml`/`.env` set → stop honcho services →
`DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION vector`
→ `alembic upgrade head` → `uv run python scripts/configure_embeddings.py
--dry-run` then `--yes` (resizes pgvector cols 1536→1024) → start services
(boot `embedding_validator` enforces schema-dim == config-dim) → verified.

**This wiped the entire Honcho store** (all workspaces/sessions/conclusions/
representations — intentional clean slate, nothing was worth keeping).
Hermes itself was untouched (file-based + SQLite `state.db`/`kanban.db`;
never uses Postgres). Backups: `config.toml.bak.voyage`, `.env.bak.voyage`.

**Verified 2026-05-16:** boot validator passed; ingest → stored
`message_embeddings.embedding` is `vector(1024)`; semantic search returns
the message; no Voyage/embedding errors.

---

## Postgres

- PostgreSQL 17.9 + pgvector 0.8.0, stock Ubuntu packages.
- Superuser `postgres` / password `postgres`, database `postgres`.
- Listens on `127.0.0.1:5432` / `[::1]:5432` only (orb-internal; not exposed
  to the Mac, by design).
- `vector` extension enabled in the `postgres` DB.

```sh
orb -m hermes-agent
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d postgres
```

---

## Networking model (why this works)

- OrbStack resolves `hermes-agent.orb.local` and **proxies all listening
  machine ports** through its gateway (`192.168.138.3`). Once a service
  listens inside the orb, it's reachable from the Mac at
  `hermes-agent.orb.local:<port>` — no port-mapping config needed.
- The machine's real IP (`192.168.139.26`) sits in a Mac `reject` route;
  that's irrelevant because traffic goes via the OrbStack proxy, not direct.
- macOS **Local Network** permission must be granted to the terminal app for
  `orb.local` access to work (System Settings → Privacy → Local Network).
- Browser and terminal use the same OrbStack DNS+proxy path — if one works,
  both work.

---

## Lessons learned (don't repeat these)

1. **`nohup ... &` inside `orb -m … bash -lc` does NOT persist.** OrbStack
   tears down the exec session's process tree on return, killing nohup'd
   children. This is why everything is a systemd service. Never background
   long-lived processes via a one-off `orb` command.

2. **Shell precedence trap:** `cd ~/x && nohup A & ... && nohup B &` only
   applies the `cd` to the first `&` group. The second ran in the
   OrbStack-mounted Mac path and polluted the Mac repo with a stray `.venv`.
   Give each backgrounded process its own explicit `cd` (or use systemd
   `WorkingDirectory`).

3. **Ubuntu 25.10 minimal images lack `xz-utils`** — Hermes `install.sh`
   fails extracting Node's `.tar.xz`. Fix: `sudo apt-get install -y
   xz-utils` before running the installer. Upstream PR:
   <https://github.com/NousResearch/hermes-agent/pull/11278>

4. **Dashboard `0.0.0.0` bind requires `--insecure`** (hardcoded loopback
   guard at `hermes_cli/web_server.py:4386`). Acceptable in the orb because
   exposure is Mac-only via the proxy.

---

## Health check one-liner

```sh
orb -m hermes-agent sudo systemctl is-active hermes-dashboard honcho-api honcho-deriver postgresql \
  && curl -s http://hermes-agent.orb.local:8000/health \
  && curl -s -o /dev/null -w " dashboard HTTP %{http_code}\n" http://hermes-agent.orb.local:9119/
```
