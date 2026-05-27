# Hermes Agent Stack

A personal Hermes Agent stack you run safely on your Mac.

Hermes runs in an isolated OrbStack VM, supporting services run in Docker.
Nothing has access to your host.

One command brings up
[Hermes](https://github.com/NousResearch/hermes-agent) (the agent),
[Honcho](https://github.com/plastic-labs/honcho) (memory),
[LiteLLM](https://github.com/BerriAI/litellm) (model gateway),
[CLIProxyAPI](https://github.com/eceasy/cli-proxy-api) (use your ChatGPT
or Claude Code subscription as an API), plus optional web search,
browser automation, and more.

```bash
# Setup & build the stack (one time)
./stack-cli setup       # interactive: pick services + models
./stack-cli build       # pull images, fetch sources, generate secrets

# Start/stop the stack on demand
./stack-cli start       # bring it all up
./stack-cli stop        # pause the stack, all data is preserved

./stack-cli info        # see what's running
```

## Why

You want a real personal AI agent that:

- **Doesn't leak your data** — runs locally; no third-party SaaS.
- **Uses your existing subscriptions** — ChatGPT Plus, Claude Code,
  Codex, Gemini CLI — instead of paying per-token a second time.
- **Remembers you across sessions** — Honcho gives Hermes durable,
  graph-based memory across chats and platforms.
- **Is yours to modify** — every service is a normal docker container
  (or OrbStack VM); pin a different version, swap a model, add your
  own service.
- **Hermes without limits** - Hermes safely runs in a VM with full capabilities to install tools as needed unlike running in a Docker container that cripples functionality

## Prerequisites

macOS (Apple Silicon or Intel) with:

- **[OrbStack](https://orbstack.dev)** — provides Docker + lightweight
  Linux VMs. Must be running before `./stack-cli start`.
- **[Bun](https://bun.sh) or Node 23+** — runs the CLI. Bun preferred
  (faster startup); Node fallback uses `--experimental-strip-types`.
- **git, openssl** — already on macOS for most users.

If you're on Linux: the docker side will mostly work but Hermes (the
agent) provisions via OrbStack-only commands. Linux port is on the
roadmap; today it's macOS-only.

## Quickstart

```bash
git clone <this-repo> hermes-stack && cd hermes-stack
./stack-cli setup
./stack-cli build
./stack-cli start
```

`setup` prompts you for:

- a project name (lets you run multiple isolated stacks side by side),
- which services to enable (defaults: hermes, honcho, honcho-ui,
  cliproxyapi — plus the auto-included pg/redis/litellm),
- which LLM models to use (defaults to ChatGPT-subscription routing
  via cliproxy + Voyage embeddings — examples for OpenRouter, OpenAI,
  Anthropic given),
- the relevant provider API key, **only** for providers your chosen
  models actually use (cliproxy users get an OAuth flow instead of an
  API key),
- optional Telegram bot credentials if you enabled Hermes.

After `start`, the agent is reachable in three places:

- **Telegram** (if you wired up a bot): your agent is now one DM away.
- **In-VM CLI**: `orb -m <project>-hermes` then `hermes` for a TUI.
- **Honcho UI** at `https://honcho-ui.<project>.orb.local` to inspect
  what Hermes remembers about you.

If you went with cliproxy models, you have one more step: open
`http://cliproxyapi.<project>.orb.local:8317/management.html`, sign in
with the management key from `.stack/.env`, and complete the OAuth
flow for each provider you want to use. The CLI tells you all of this
at the end of `setup`.

## Common commands

| Command | What it does |
|---|---|
| `./stack-cli setup` | Interactive first-time configuration (also for adding services later) |
| `./stack-cli enable <svc>` | Cascade-enable a service (auto-includes its dependencies) |
| `./stack-cli disable <svc>` | Disable (refuses if other enabled services depend on it) |
| `./stack-cli build` | Resolve image digests, fetch pinned sources, render configs, generate secrets |
| `./stack-cli start` | Bring the whole stack up (backends → preflight → services → VMs) |
| `./stack-cli stop` | Bring it down (VMs + `docker compose down`; volumes kept) |
| `./stack-cli restart` | `stop` + `start`. Use this to apply VM config changes. |
| `./stack-cli info` | Overview: what's enabled + runtime state of containers + VMs |
| `./stack-cli logs` | Tail the Hermes VM's console |
| `./stack-cli reconfigure <svc>` | Re-render a service's runtime config from its template |

## What's in the box

Each service lives under `services/<svc>/` and is opt-in via setup
or `./stack-cli enable`. The marquee ones:

- **hermes** — the agent. Runs in a sandboxed OrbStack VM with
  Telegram, web search, browser automation, and durable memory.
- **honcho** + **honcho-ui** — graph-based memory. The web UI lets
  you inspect peers/sessions and what Hermes has learned.
- **litellm** — gateway. Mints virtual keys per consumer, logs every
  call, lets you swap providers without touching service code.
- **cliproxyapi** — OAuth-based bridge to ChatGPT Plus / Claude Code /
  Codex / Gemini CLI subscriptions. Use what you already pay for.
- **searxng** — privacy-respecting metasearch; Hermes' default
  `web_search` backend.
- **camofox-browser** — Camoufox-based headless browser; Hermes'
  default browser tool.
- **firecrawl** — web scraper API (opt-in).
- **browser-use** — alternative LLM-driven browser agent (opt-in).
- **agentmemory**, **hindsight** — alternative memory backends.

## Going deeper

- [docs/architecture.md](docs/architecture.md) — multi-stack scoping,
  the secrets model, the build/start pipeline, the dc() wrapper, the
  hermetic env handling.
- [docs/services.md](docs/services.md) — per-service reference (model
  levers, what runs in what mode, security caveats).
- [docs/gotchas.md](docs/gotchas.md) — the hard-won list. Read this
  before debugging.
- [docs/development.md](docs/development.md) — how to add a service
  or modify an existing one.

## Status

Early. The CLI works end-to-end on macOS+OrbStack; tests pass; the
stack has been brought up from scratch and verified. Things that may
still bite you are listed in [docs/gotchas.md](docs/gotchas.md).

License: see `LICENSE` (TBD).
