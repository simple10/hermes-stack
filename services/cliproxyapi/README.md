# cliproxyapi — notes

router-for-me/CLIProxyAPI wraps ChatGPT Codex / Gemini CLI / Claude Code /
Grok **OAuth subscriptions** as an OpenAI/Gemini/Claude/Codex-compatible API.
In this stack it's a **standalone** profiled service (`[cliproxyapi]`) — an
*alternative* upstream proxy, **not** a LiteLLM consumer. Intended use: a
streaming-correct ChatGPT/Codex (responses) proxy to sidestep LiteLLM's
non-streaming `chatgpt/*` bug (gotcha #5) until that's fixed upstream.

- Image: pinned `eceasy/cli-proxy-api:${CLIPROXY_VERSION}` (bump deliberately).
- Config is **file-based** (no env support): committed `config.yaml.template`
  → gitignored `config.runtime.yaml` (rendered by `build.sh`, which injects
  `CLIPROXY_API_KEY` + `CLIPROXY_MANAGEMENT_KEY` from `.stack/.env`).
- OAuth tokens persist in the project-scoped `cliproxyapi-auth` volume.
- **No host ports** (stack convention) — reachable only in-OrbStack at
  `cliproxyapi.<project>.orb.local:8317`. Endpoints: `/v1/*` (api-key gated),
  `/healthz` (open), `/management.html` (admin SPA; `/` is just API-info JSON).

## Doing the one-time provider OAuth login (the normal way)

1. Open `http://cliproxyapi.<project>.orb.local:8317/management.html`
   (e.g. `cliproxyapi.aitools.orb.local`), enter `CLIPROXY_MANAGEMENT_KEY`
   (`grep ^CLIPROXY_MANAGEMENT_KEY= .stack/.env`).
2. Start a provider login (e.g. ChatGPT/Codex). The browser is sent to the
   provider, you authenticate, then it redirects to a **fixed loopback URL**
   like `http://localhost:1455/...callback?code=...` — which **fails to load
   (connection refused). THIS IS EXPECTED / BY DESIGN.**
3. Copy that failed callback URL from the browser address bar and **paste it
   into the panel's "callback URL" field**. The server extracts the code and
   completes the token exchange. Done — no browser→container reachability
   needed, no host ports.

That copy/paste is the whole reason we do **not** publish any host ports.

## If we ever want to remove the copy/paste step (the loopback approach)

The callback URLs are the providers' **pre-registered redirect URIs** —
fixed, no config/env override (verified in v7.1.11 source:
`managementCallbackURL` → `http://127.0.0.1:%d`, and per-provider
`auth/*` packages hardcode their ports). The browser is hard-redirected
there, so the *only* way to skip the paste is to make those loopback ports
on the **Mac** actually reach the container — i.e. loopback-publish them
(exactly what CLIProxyAPI's own upstream `docker-compose.yml` does). A
redirect/proxy service can't help: the first post-OAuth hop is the fixed
registered URL; nothing else is ever contacted.

**This was implemented and verified working, then reverted** (the copy/paste
flow makes it unnecessary, and host ports break the stack's orb-DNS-only
convention + risk Mac port conflicts). To re-enable, add this back to
`compose.yaml` under the `cliproxyapi` service (drop the `expose:`-only note):

```yaml
    # 127.0.0.1-ONLY (never 0.0.0.0/LAN). orb DNS keeps working regardless.
    # Uncomment only the provider callback port(s) you actually log in.
    ports:
      # API + panel + /v0-management-based callbacks (anthropic/google/codex/
      # xai/antigravity). Host port may be remapped if 8317 is taken on the Mac.
      - "127.0.0.1:8317:8317"
      # ChatGPT/Codex callback. FIXED at 1455 (OpenAI's pre-registered Codex
      # redirect URI http://localhost:1455/...). host:container MUST be 1455:1455.
      - "127.0.0.1:1455:1455"
      # Gemini CLI (Google) — geminiAuth.DefaultCallbackPort:
      # - "127.0.0.1:8085:8085"
      # Antigravity — antigravity.CallbackPort:
      # - "127.0.0.1:51121:51121"
      # Other provider/flow/version variants upstream publishes (xAI/Grok,
      # Claude). NOTE: xai source = CallbackPort 56121, which differs from the
      # 54545/11451 upstream publishes — treat these two as best-effort;
      # confirm the actual port from the failed callback URL when logging in.
      # - "127.0.0.1:54545:54545"
      # - "127.0.0.1:11451:11451"
```

Port → provider map (from CLIProxyAPI v7.1.11 source):

| Port  | Provider / purpose                                              | Source |
|-------|-----------------------------------------------------------------|--------|
| 8317  | API + `/management.html` + `/v0`-management OAuth callbacks (anthropic/google/codex/xai/antigravity `/x/callback`) | `managementCallbackURL` |
| 1455  | **ChatGPT/Codex** OAuth callback — FIXED (OpenAI Codex registered redirect URI) | empirically + Codex client |
| 8085  | Gemini CLI (Google) OAuth callback                              | `auth/gemini` `DefaultCallbackPort=8085` |
| 51121 | Antigravity OAuth callback                                      | `auth/antigravity` `CallbackPort=51121` |
| 54545, 11451 | Other provider/flow/version variants (xAI/Grok, Claude); best-effort — verify from the actual failed callback URL | upstream `docker-compose.yml` port set |

Re-enable steps: paste the block in → recreate (`dc up -d cliproxyapi`) →
the port(s) bind `127.0.0.1` only (verify:
`docker inspect -f '{{json .NetworkSettings.Ports}}' <cid>`) → do the login
at **`http://127.0.0.1:8317/management.html`** (so the panel origin matches
the loopback callbacks; no paste needed). Each callback port must be **free
on the Mac** during login; only needed for the one-time login, can be
reverted after.
