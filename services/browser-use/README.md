# browser-use

[browser-use](https://github.com/browser-use/browser-use) — LLM-driven
browser-automation agent (MCP, stdio). Built from a pinned commit
(`BROWSER_USE_VERSION` lever) via upstream's Dockerfile (bundles Chromium
+ uv — heavy first build). `SERVICE_REQUIRES=litellm`.

FULLY LOCAL — no cloud key, telemetry/cloud-sync/version-check off; all
inference via LiteLLM on the minted `BROWSER_USE_VIRTUAL_KEY`.

## Levers

```
BROWSER_USE_MODEL=${STACK_LLM_MODEL}
```

## Ready-worker pattern

The container stays up but does nothing until you `docker exec -i` into
it to spawn the stdio MCP server on demand:

```
docker exec -i <project>-browser-use-1 python -m browser_use.mcp
```

## Hermes integration

Hermes has first-class browser-use support via `browser_use_cloud` (paid
API). The self-hosted path here is for direct MCP-stdio clients — Hermes
won't auto-wire it (the cloud variant is what Hermes natively supports).
