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

## Source / version

Source-built from the pinned `_source/` tree. The repo publishes no tags, so the pin is a
commit SHA in `service.yaml`. Bump via `FIRECRAWL_UI_VERSION` in `.stack/.env` (or
`stack-cli update firecrawl-ui`).

## Enable

```
stack-cli enable firecrawl-ui    # cascades: requires firecrawl
stack-cli build && stack-cli start
```
