# Hermes Agent Stack

A personal Hermes Agent stack you run safely on your Mac.

Hermes runs in an isolated OrbStack VM.

Supporting services run in Docker.

Nothing has access to your Mac filesystem by default.

**One command brings up:**

- [Hermes](https://github.com/NousResearch/hermes-agent) agent
- [Honcho](https://github.com/plastic-labs/honcho) - memory
- [LiteLLM](https://github.com/BerriAI/litellm) - LLM gateway
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) - use your ChatGPT
or Claude Code subscription as an API
- Optional services for web search, browser automation, dashboards and more.

## Quick Start

Just configure the stack, build it, and run...

```bash
# Clone this repo
git clone https://github.com/simple10/hermes-stack && cd hermes-stack

# Setup & build the stack (one time)
./stack-cli setup       # interactive: pick services + models
./stack-cli build       # pull images, fetch sources, generate secrets

# Start/stop the stack on demand
./stack-cli start       # bring it all up
./stack-cli stop        # pause the stack, all data is preserved

./stack-cli info        # see what's running

# View all the available commands
./stack-cli
```

## Quick Wins

Configure the stack with Honcho memory and SearXNG enabled.

Then run `./stack-cli chrome-cdp` to start a separate chrome browser instance
on your Mac.

Hermes can then use SearXNG for web scraping and your local chrome
to bypass any bot detection. You can manually log in to web sites without ever
giving Hermes your website passwords.

## Why Hermes Agent Stack

You want a real personal AI agent with:

- **Safety first** - Hermes runs isolated from your Mac, unable to reach
  files or other servers on your Mac unless you give it access.
- **Batteries included** - multiple memory providers, browser tools and
  even local browser CDP baked in and ready to run.
- **Doesn't leak your data** — runs locally; no third-party SaaS.
- **Uses your existing subscriptions** — ChatGPT Plus, Claude Code,
  Codex, Gemini CLI — instead of paying per-token a second time.
- **Remembers you across sessions** — Honcho gives Hermes durable,
  graph-based memory across chats and platforms.
- **Is yours to modify** — every service is a normal docker container
  (or OrbStack VM); pin a different version, swap a model, add your
  own service.

Hermes safely runs in an isolated VM with **full capabilities** to install tools as needed, unlike running in a Docker container that cripples functionality.

You can re-use the Docker services for any local agent or even spin up multiple
instances of Hermes.

> **LiteLLM** is used to proxy all LLM requests by default. This makes it easy
> to set token budgets, rotate keys, view logs, etc. You can optionally disable
> LiteLLM if you want to reduce memory usage. The stack is yours to modify.

## Prerequisites

macOS (Apple Silicon or Intel) with:

- **[OrbStack](https://orbstack.dev)** — provides Docker + lightweight
  Linux VMs. Must be running before `./stack-cli start`.
- **[Bun](https://bun.sh) or Node 23+** — runs the CLI. Bun preferred
  (faster startup); Node fallback uses `--experimental-strip-types`.
- **git, openssl** — already on macOS for most users.

If you're on Linux: the docker services will work but Hermes (the
agent) provisions via OrbStack-only commands. Linux port is on the
roadmap; today it's macOS-only. If you need Linux today, just have
claude or codex fork this project. The code is simple.

## Setup

`./stack-cli setup` prompts you for:

- Project name (lets you run multiple isolated stacks side by side)
- Services to enable (defaults: hermes, honcho, honcho-ui,
  cliproxyapi — plus the auto-included pg/redis/litellm)
- LLM models to use (defaults to ChatGPT-subscription routing
  via cliproxy + Voyage embeddings — examples for OpenRouter, OpenAI,
  Anthropic given)
- Provider API key, **only** for providers your chosen
  models actually use (cliproxy users get an OAuth flow instead of an
  API key)
- Optional Telegram bot credentials if you enabled Hermes

If you prefer, you can skip most of the setup and manually configure Hermes
after it starts.

After `start`, your Hermes agent is reachable via:

1. Browser on your Mac - start command outputs the dashboard url for you
2. CLI - run the hermes CLI or ssh into the VM to run any command
3. **Telegram** - if you wired up Telegram during setup

```bash
# Run hermes CLI...

# Enter the VM then run hermes
./stack-cli ssh
hermes

# Or simply run hermes commands from your Mac
./stack-cli hermes <cmd>

# Hermes only runs in the VM
# ./stack-cli hermes just saves you a step
```

If you went with cliproxy models during setup, you have one more step: open
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
| `./stack-cli start` | Bring the whole stack up (backends →
  preflight → prestart → up → poststart → VMs) |
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
