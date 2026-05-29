# camofox-browser

Standalone stealth headless-browser API (Camoufox/Firefox) for AI agents.
No backend deps. Built from a pinned [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser)
commit (`CAMOFOX_BROWSER_VERSION` lever). Reached at
`camofox-browser.<project>.orb.local:9377`.

Hermes auto-wires `CAMOFOX_URL` into `~/.hermes/.env` when this profile is
active (Hermes' first-class `camofox` browser provider — see
`tools/browser_camofox.py` in hermes-agent).

## Levers

```
CAMOFOX_AUTH=disabled    # drops bearer-key gate (REQUIRED for Hermes;
                         # Hermes doesn't send Authorization headers)
CAMOFOX_MEM=2g
CAMOFOX_CPU=2
CAMOFOX_HEAP_MB=128      # MAX_OLD_SPACE_SIZE for the node runtime
```

## ⚠ CAMOFOX_AUTH choice

The default in `service.yaml` is `CAMOFOX_AUTH=disabled` because every
known client in this stack (Hermes) doesn't send `Authorization: Bearer`.
The trust boundary is then orb-DNS-only exposure (no host port mapping —
only services on the project network can reach :9377).

If you set `CAMOFOX_AUTH=` (unset) or any other value, `build.ts` generates
a bearer key into `.stack/camofox-browser/.generated.env` and the server
requires it. Clients without `Authorization: Bearer <key>` get HTTP 401.

## First-build heavy

The image bundles Camoufox (~300 MB download) + Firefox + Xvfb. First
`just build` is slow; subsequent builds skip if the pinned source SHA is
unchanged (`stack_source` rebuild detection).
