# Services

Per-service reference. See each `services/<svc>/README.md` for design
notes and the upstream project for full documentation.

## Substrate (auto-pulled by consumers)

These get enabled automatically by `SERVICE_REQUIRES` cascade; you
rarely select them directly.

- **pg** — `pgvector/pgvector:pg18`. Each consumer (litellm, honcho,
  hindsight) seeds its own role/db via a one-shot provisioner.
- **redis** — `redis:8.6.3`.
- **rabbitmq** — pulled in by firecrawl only.

## LLM gateway

- **litellm** — `ghcr.io/berriai/litellm-database`. ISSUES virtual
  keys for every other consumer (`SERVICE_LITELLM_KEY=true` adds the
  service to `LITELLM_VIRTKEYS`; `preflight.ts` mints one virtual key
  per alias on every start, self-healing across DB rotations).
  Routes everything that's not a direct API to its upstream provider:
  `openrouter/*`, `voyage/*`, `cliproxy/*`, `chatgpt/*`, etc.

- **cliproxyapi** — `eceasy/cli-proxy-api`. OAuth-based bridge to
  ChatGPT Plus / Claude Code / Codex / Gemini CLI subscriptions.
  Standalone (not a litellm consumer; it's an *upstream* provider).
  After `./stack-cli start`, open
  `http://cliproxyapi.<project>.orb.local:8317/management.html`,
  sign in with `CLIPROXY_MANAGEMENT_KEY`, and run the OAuth flow per
  provider. The provider OAuth callback **failing in the browser is
  expected** — copy the failed callback URL and paste it into the
  panel's callback field; the server completes the token exchange
  (no browser→container reachability needed).

## The agent

- **hermes** (VM) — [Nous Research Hermes](https://github.com/NousResearch/hermes-agent).
  Runs in an OrbStack Ubuntu machine (`--isolated --isolate-network`).
  Its `~/.hermes/` is bind-mounted from `.stack/hermes/.hermes/` so
  config + logs are visible Mac-side and survive VM recreation.
  Three systemd units run inside the VM:
  - `hermes-gateway` — the agent core.
  - `hermes-dashboard` — extended HTTP APIs.
  - `hermes-logtail` — tails `gateway.log` + `errors.log` to
    `/dev/console` (OrbStack Logs tab).

  Model lever: `HERMES_MODEL` (defaults to `${STACK_LLM_MODEL}`).
  Memory backend lever: `HERMES_MEMORY` (honcho / hindsight /
  agentmemory / holographic / default).
  Telegram credentials (`HERMES_TELEGRAM_BOT_TOKEN` /
  `HERMES_TELEGRAM_ALLOWED_USERS` / `HERMES_TELEGRAM_HOME_CHANNEL`)
  enable the Telegram bot interface; leave blank to skip.

- **hermes-workspace** — the desktop UI for Hermes
  ([openconcho/hermes-workspace](https://github.com/openconcho/hermes-workspace)).
  Opt-in. Requires `HERMES_GATEWAY_ALLOW_ACCESS=true` because it
  needs the hermes gateway exposed on the docker network. When the
  gate is open, the gateway binds 0.0.0.0:8642 inside the VM and
  every request must carry `HERMES_GATEWAY_API_KEY`.

## Memory backends

Hermes uses one at a time, via `HERMES_MEMORY`.

- **honcho** — graph-based memory.
  [plastic-labs/honcho](https://github.com/plastic-labs/honcho).
  Two containers: `honcho-api` + `honcho-deriver`. Built from a
  pinned commit (`HONCHO_VERSION` lever; bump in `.stack/.env`).
  Model levers: `HONCHO_DERIVER_MODEL`, `HONCHO_SUMMARY_MODEL`,
  `HONCHO_DREAM_MODEL` (all default to `${STACK_LLM_MODEL_FAST}`);
  `HONCHO_DIALECTIC_MODEL` (defaults to `${STACK_LLM_MODEL}`);
  `HONCHO_EMBEDDING_MODEL` (defaults to `${STACK_LLM_EMBEDDING_MODEL}`).
  Embedding dim is fixed at first provisioning — see
  `docs/gotchas.md`.

- **honcho-ui** — web UI for Honcho.
  [offendingcommit/openconcho](https://github.com/offendingcommit/openconcho).
  Static SPA + nginx with a same-origin proxy at `/honcho/` (Honcho's
  hardcoded CORS allowlist blocks cross-origin browser calls; nginx
  sidesteps it). The first-run form opens pre-filled with the
  correct endpoint — just click Save. The web UI also lets you
  inspect peers/sessions and what Hermes has learned.

- **hindsight** — vector + reranker memory.
  [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight).
  Prebuilt image. Model lever: `HINDSIGHT_MODEL`. Reranker lever:
  `HINDSIGHT_RERANKER` (`local` / `litellm` / `rrf`). API on
  `:8888`, Control-Plane UI on `:9999`.

- **agentmemory** — fast file-based memory via an MCP shim.
  Standalone (file-based state on its own volume; no pg/redis).
  Model + embedding levers (`AGENTMEMORY_MODEL`,
  `AGENTMEMORY_EMBEDDING_MODEL`). The viewer UI on `:3113` is an
  unauthenticated admin surface — disable with
  `AGENTMEMORY_EXPOSE_VIEWER=0` if you don't want it.

## Tools (opt-in)

- **searxng** — privacy-respecting metasearch. Hermes' default
  `web_search` backend. Tag-class image; bump via `SEARXNG_VERSION`.
  Owns its own `SEARXNG_SECRET_KEY` (gen-once).

- **camofox-browser** — Camoufox (fingerprint-spoofing Firefox fork)
  headless-browser API. Hermes' default browser tool. Set
  `CAMOFOX_AUTH=disabled` if you want it auth-free (required for
  Hermes since Hermes doesn't send bearer tokens to Camofox).

- **firecrawl** — web-scrape API.
  [firecrawl/firecrawl](https://github.com/firecrawl/firecrawl). Uses
  a **dedicated** `firecrawl-postgres` appliance (pg_cron-based queue
  engine) — never the shared pg. Self-hosted Firecrawl does NOT ship
  the interactive browser-session endpoints; use plain `/v1/scrape`
  or `/v2/scrape` without browser actions.

- **browser-use** — LLM-driven browser automation agent. Built from
  the upstream Dockerfile (bundles Chromium + uv + python3.12).
  Container is a long-lived "ready worker" (`sleep infinity`);
  consumers spawn the stdio MCP server on demand via `docker exec`.

- **localhost-proxy** — multi-socat container that bridges chosen
  Mac-host ports into the orb network (used by `chrome-cdp`, etc.).
  Standalone.

## Model levers

`./stack-cli setup` sets three top-level levers in `.stack/.env`:

```env
STACK_LLM_MODEL=cliproxy/gpt-5.5
STACK_LLM_MODEL_FAST=cliproxy/gpt-5.4-mini
STACK_LLM_EMBEDDING_MODEL=voyage-4-lite
```

Per-service `*_MODEL` keys inside each `#>--- svc ---` block reference
these via `${STACK_LLM_MODEL}` — so a single edit at the top changes
every service's model. Per-service overrides live inside each block,
edited freely; they survive enable/disable round-trips.

Provider prefixes the gateway understands:

- `cliproxy/<model>` — routes through CLIProxyAPI (your subscriptions).
- `openrouter/<vendor>/<model>` — pay-per-token via OpenRouter.
- `openai/<model>` / `anthropic/<model>` — direct provider APIs.
- `voyage-*` — Voyage embeddings (via litellm).

`./stack-cli setup` only prompts for the API keys you actually need
based on the providers you chose.
