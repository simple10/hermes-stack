# ChatGPT Subscriptions for LiteLLM

This dir can be bind mounted into the LiteLLM container at `~/.config/litellm/chatgpt` or whatever dir is
configured via CHATGPT_TOKEN_DIR env var.

## To use a ChatGPT Subscription

1. `auth.json` must be pre-configured or the LiteLLM logs watched (see below)
2. ChatGPT models configured in `config.yaml`
3. env vars configured in docker compose.yaml

On first usage of a ChatGPT model, if auth.json is not present or invalid, LiteLLM prints the device pairing
code in the logs and waits for the code to be authorized or the request to timeout.

Bind mount this `chatgpt` dir to `~/.config/litellm/chatgpt` in the LiteLLM container
so token refresh survives restarts.

**Important:** auth.json is not quite the same format as ~/.codex/auth.json.

It's the inner `tokens` key value from `~/.codex/auth.json`:

```json
{
  "access_token": "<JWT>",
  "refresh_token": "<token>",
  "id_token": "<JWT>",
  "expires_at": 1750000000,
  "account_id": "<chatgpt_account_id>"
}
```

## Env Vars

CHATGPT_DEFAULT_INSTRUCTIONS: " "

LiteLLM injects the full codex system prompt preamble by default to spoof (act as) a codex client.

OpenAI might start rejecting requests that don't include the preamble instructions since it's easy to
detect the spoofed request without it.

Hermes does not include the preamble in its native codex subscription support.

Until ChatGPT starts blocking requests, it's recommended to match hermes native behavior to avoid unexpected behavior
when using the LiteLLM ChatGPT models with hermes.

Set `CHATGPT_DEFAULT_INSTRUCTIONS` to a single space in compose.yaml. LiteLLM will inject the default codex instructions
if the value is empty.

```yaml
  # LiteLLM Docker Compose YAML
  environment:
    CHATGPT_DEFAULT_INSTRUCTIONS=" "
```
