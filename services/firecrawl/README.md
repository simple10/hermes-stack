# firecrawl

[Firecrawl](https://github.com/firecrawl/firecrawl) — self-hosted web
scraper API (nuq-backed). Three containers when enabled:
`firecrawl-api`, `firecrawl-playwright`, `firecrawl-postgres` (dedicated;
NOT the shared `pg`). All on the project network at
`firecrawl-api.<project>.orb.local:3002`.

`SERVICE_REQUIRES=redis,rabbitmq,litellm` — `just enable firecrawl` cascades.

Hermes auto-wires (when this profile is active): seeds `FIRECRAWL_API_URL`
+ placeholder `FIRECRAWL_API_KEY=fc-selfhost-noauth` into `~/.hermes/.env`
(the self-hosted instance has `USE_DB_AUTHENTICATION=false`; the SDK still
requires a non-empty key, hence the labeled placeholder).

## Levers

```
FIRECRAWL_MODEL=${STACK_LLM_MODEL}   # extract / structured output
FIRECRAWL_API_MEM=4g                 # lighter than upstream's 8g default
FIRECRAWL_API_CPU=2                  # lighter than upstream's 4 default
FIRECRAWL_PLAYWRIGHT_MEM=2g
FIRECRAWL_PLAYWRIGHT_CPU=2
```

## Three digest-pinned images

All published at `ghcr.io/firecrawl/*`. Upstream ships no semver — digest
is the only stable pin. Bump per-image via `FIRECRAWL_API_VERSION` /
`FIRECRAWL_PLAYWRIGHT_VERSION` / `FIRECRAWL_POSTGRES_VERSION` in
`.stack/.env` (resolved at `just build`). Note: `firecrawl-postgres` is
linux/amd64-only — runs under Rosetta on arm64.

## Quick check

```
curl -sS -m10 -X POST http://firecrawl-api.<project>.orb.local:3002/v2/scrape \
  -H "Authorization: Bearer fc-selfhost-noauth" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```
