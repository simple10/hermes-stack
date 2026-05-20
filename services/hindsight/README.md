# hindsight

Pg-backed agent memory with reranking. `SERVICE_REQUIRES=pg,litellm`. When
`HERMES_MEMORY=hindsight`, Hermes loads the official `hindsight` plugin
(local_external mode) and connects to `hindsight.<project>.orb.local:8888`.
The plugin auto-installs `hindsight-client` on first session.

## Levers

```
HINDSIGHT_MODEL=${STACK_LLM_MODEL}
HINDSIGHT_EMBEDDING_MODEL=${STACK_LLM_EMBEDDING_MODEL}
HINDSIGHT_RERANKER=local            # local | litellm | rrf
HINDSIGHT_RERANK_MODEL=rerank-voyage
```

### Reranker tradeoffs

| `HINDSIGHT_RERANKER` | quality | RAM | latency | cost | notes |
|---|---|---|---|---|---|
| `local` | best | ~600 MB | low | $0 | in-process Torch cross-encoder |
| `litellm` | ~best | minimal | network hop | per-rerank Voyage API | observable in SpendLogs |
| `rrf` | weakest | minimal | trivial | $0 | pure rank-fusion, no model |

## DB lifecycle

Owns its own pg role + db. New role/db ⇒ recreate the `<project>_pg-data`
volume to re-run provisioner.
