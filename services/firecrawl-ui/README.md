# firecrawl-ui

A 3rd-party web UI ([obeone/firecrawl-ui](https://github.com/obeone/firecrawl-ui)) for
the self-hosted **Firecrawl** API. Firecrawl ships no UI of its own; this Vue 3 + Vite
SPA talks directly to the Firecrawl API from the browser (scrape / crawl / map / extract,
with results export).

> Evaluation service — we'll likely fork and improve it before officially adopting it.
> For now it's wired up so we can poke around the live Firecrawl API.

## URL

```
https://firecrawl-ui.<project>.orb.local
```

(OrbStack auto-HTTPS fronts the unprivileged nginx on :8080.)

## How it connects

The Firecrawl API base URL is **baked at build time** (`FIRECRAWL_API_BASE_URL` →
`VITE_FIRECRAWL_API_BASE_URL`) to this stack's API over OrbStack auto-HTTPS:

```
https://firecrawl-api.<project>.orb.local
```

Same `https` scheme as the page (no mixed content) and the Firecrawl API returns
`Access-Control-Allow-Origin: *`, so the browser calls it directly — no reverse proxy
(unlike honcho-ui). You can override the base URL and API key in the in-app **settings**
(stored in `localStorage`). The self-hosted API runs with `USE_DB_AUTHENTICATION=false`,
so the key can be left blank.

## Feature coverage vs. the self-hosted Firecrawl v3 API

The UI has five sections — **Scrape, Crawl, Extract, Map, Search** — and they're deep,
not just stubs. In particular the **Scrape** view exposes nearly every per-request option:
`formats`, `actions` (click/scroll/type/JS before scrape), `screenshot`, `changeTracking`,
inline `json`+`schema` extraction, `location`/`country`, `proxy`, `stealth`, `mobile`,
`waitFor`, `headers`, include/exclude tags, `maxAge` caching, `parsePDF`, `blockAds`.
**Crawl** covers limit/depth/path filters/sitemap plus full webhook config.

### Missing from the UI (endpoints with no view)

- **Batch Scrape** (`POST /batch/scrape`) — scrape an explicit *list* of URLs in one async
  job (distinct from Crawl, which discovers URLs). **The clearest high-value gap** — no UI
  at all, and it reuses the same async-job + format machinery the Crawl/Extract views
  already have. Top candidate if we fork.
- **Monitor** (`/monitor/*`) — scheduled/recurring scrapes + change-detection checks.
- **Browser sessions** (`/browser/*`, `/scrape/:id/interact`) — persistent live browser.
  Niche; Scrape's inline `actions` already covers most interactive needs.
- **Parse** (`POST /parse`) — document/PDF → markdown without a full scrape. Minor.
- No global "active/ongoing jobs" view (`/crawl/active`, `/crawl/ongoing`).

Not worth building (cloud/billing, irrelevant to self-host): `team/*` (credit/token usage,
queue-status), `x402/*` (payments), `support/*` (Firecrawl's own docs bot),
`concurrency-check`.

### Agentic features — NOT functional on self-host

Firecrawl's agentic capabilities are present in the code but **do not work on a vanilla
self-host**, so the absent **Agent** UI is moot here — don't build one:

- **FIRE-1 Agent** (`/v2/agent`, the "v3-beta" agent) is hard-gated on
  `EXTRACT_V3_BETA_URL` and proxies to a **closed Firecrawl-hosted backend**
  (`/internal/extracts`). Unset here (and unsettable without their service). Verified live:
  `POST /v2/agent` errors with the wrapped *"Agent beta is not enabled."*; `/extract` with
  `agent.model=v3-beta` is rejected too.
- The in-scrape **`smartScrape`** agent (`v1Agent` prompt, `useAgent`/`fire-1` extract) is
  hardcoded to proprietary/external models (`firecrawl/smart-scrape`, `gemini-2.5-pro/flash`)
  that our litellm→cliproxy can't serve, so it errors in practice.

**What *does* work** is LLM-powered (not autonomous): **structured extraction** via the
scrape `json`/`schema` format and `/extract` route through **our litellm**
(`FIRECRAWL_MODEL`) — verified live. Plus scripted scrape `actions`. Real agentic mode
would require Firecrawl's cloud (`api.firecrawl.dev`); it can't be lit up by configuring
this stack.

## Source / version

Source-built from the pinned `_source/` tree. The repo publishes no tags, so the pin is a
commit SHA in `service.yaml`. Bump via `FIRECRAWL_UI_VERSION` in `.stack/.env` (or
`stack-cli update firecrawl-ui`).

## Enable

```
stack-cli enable firecrawl-ui    # cascades: requires firecrawl
stack-cli build && stack-cli start
```
