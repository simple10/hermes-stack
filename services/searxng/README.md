# searxng

[Privacy-respecting metasearch](https://docs.searxng.org/) — aggregates 70+
search engines, no per-engine API keys, no telemetry. Opt-in via the
`[searxng]` Compose profile.

## How Hermes uses it

Per the [Hermes web-search docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search),
SearXNG is selected via:

```yaml
# ~/.hermes/config.yaml
web:
  search_backend: "searxng"
```

…plus `SEARXNG_URL` in `~/.hermes/.env`. Both are written automatically by
`machines/hermes/build.ts` when the `[searxng]` profile is active in
`COMPOSE_PROFILES`.

Hermes calls `GET /search?q=<query>&format=json` — which is why our overlay
adds `json` to `search.formats` (the upstream default is `html` + `csv`
only; JSON requests get HTTP 403 without the override).

## SearXNG is search-only

It returns search results (title, URL, snippet) — it does NOT extract page
content. For `web_extract` capability you'd add Firecrawl, Tavily, etc.
alongside.

## Config

```
# .stack/.env
COMPOSE_PROFILES=...,searxng    # opt-in
# SEARXNG_VERSION=2026.5.17-d7e8b7cd1  # pin lever (optional; tag class)
# SEARXNG_CPU=1   SEARXNG_MEM=512m     # resource limits
```

Secrets: `services/searxng/build.ts` generates `SEARXNG_SECRET_KEY` once into
`.stack/searxng/.generated.env` and renders the runtime
`.stack/searxng/settings.yml` from `settings.yml.template`.

## Quick check

```
curl -s "http://searxng.aitools.orb.local:8080/search?q=test&format=json" | head -c 200
```

Should return JSON with a `results` array. HTTP 403 → JSON not enabled (re-run
`just build searxng`); HTTP 5xx → check `dc logs searxng`.
