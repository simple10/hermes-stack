# ChatGPT Subscriptions for LiteLLM

This dir can be bind mounted into the LiteLLM container at `~/.config/litellm/chatgpt` or whatever dir is
configured via CHATGPT_TOKEN_DIR env var.

To use a ChatGPT subscription:

1. `auth.json` must be pre-configured or the litellm logs watched (see below)
2. chatgpt models configured in `config.yaml`

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
