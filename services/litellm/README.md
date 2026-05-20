# litellm

[LiteLLM](https://github.com/BerriAI/litellm) proxy — every LLM /
embedding / rerank call in the stack routes through here for key rotation
+ SpendLogs observability + central fallback config. Pinned via digest
(`LITELLM_VERSION` lever; resolved at `just build` from
`LITELLM_IMAGE_REPO` + `LITELLM_IMAGE_DEFAULT`).

`SERVICE_REQUIRES=pg,redis`. Doesn't itself consume a virtual key — it's
the ISSUER (any service with `SERVICE_LITELLM_KEY=true` gets one minted
by litellm's preflight, surfaced as `<svc>_VIRTUAL_KEY` in
`.stack/litellm/.generated.env`).

## Levers (stack-wide LLM defaults)

```
STACK_LLM_MODEL=cliproxy/gpt-5.5            # primary chat (high-tier)
STACK_LLM_MODEL_FAST=cliproxy/gpt-5.4-mini  # high-volume background tier
STACK_LLM_EMBEDDING_MODEL=voyage-4-lite     # embeddings (litellm->voyage)
```

These are stack-wide because most services reference them through their own
`*_MODEL=${STACK_LLM_MODEL}` levers in their own service blocks. Repoint
the whole stack at once by editing here; override per-service by editing
the consuming service's block.

## Model registry

`config.yaml.template` defines the `model_list`. cliproxy/* entries point
at the sibling [cliproxyapi](../cliproxyapi/) service (OAuth-backed ChatGPT
Codex / Gemini / Claude / Grok). voyage/* go direct via `VOYAGE_API_KEY`.
openrouter/* go via `OPENROUTER_API_KEY`.

Re-render `.stack/litellm/config.runtime.yaml` from the template:
`just reconfigure litellm` (backs up the old runtime; you'll need
`dc restart litellm` to pick it up).

## ChatGPT subscription bind-mount

See [README-chatgpt.md](README-chatgpt.md) for OAuth setup (one-time, manual).
The token persists at `.stack/litellm/chatgpt/auth.json` (gitignored).
