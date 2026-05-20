# honcho

[Honcho](https://github.com/plastic-labs/honcho) — agentic memory backend.
Built from a pinned `plastic-labs/honcho` commit (`HONCHO_VERSION` lever).
`SERVICE_REQUIRES=pg,redis,litellm` (deps auto-pulled by `just enable`).

Hermes talks to it at `honcho-api.<project>.orb.local:8000` (auto-wired when
`HERMES_MEMORY=honcho`).

## Levers

```
HONCHO_DERIVER_MODEL=${STACK_LLM_MODEL_FAST}    # background derivation (volume tier)
HONCHO_SUMMARY_MODEL=${STACK_LLM_MODEL_FAST}    # session summaries
HONCHO_DREAM_MODEL=${STACK_LLM_MODEL_FAST}      # dream-pass
HONCHO_DIALECTIC_MODEL=${STACK_LLM_MODEL}       # interactive (main tier)
HONCHO_EMBEDDING_MODEL=${STACK_LLM_EMBEDDING_MODEL}
```

Override individual stages by editing the value. Bump the whole stack at
once via `STACK_LLM_MODEL[_FAST]` in the `litellm` block.

## DB lifecycle

Owns its own role + db on shared `pg`. Recreate from scratch by deleting the
`<project>_pg-data` volume; the provisioner re-runs on next `just start`.
