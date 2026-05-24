# localhost-proxy

Tiny multi-socat container that bridges **isolated VMs → Mac host**. The hermes
VM is created with `--isolated --isolate-network`, so it cannot reach Mac IPs
directly. Docker containers are NOT subject to that isolation — they can still
reach the Mac via `host.docker.internal`. This proxy sits in the middle:

```
isolated VM  ──orb DNS──►  localhost-proxy container  ──host-gateway──►  Mac host
            (allowed)                                    (allowed)
```

**Blast radius of a compromised VM-side service = exactly the ports in
`LOCALHOST_PROXY_PORTS`, and nothing else on your Mac.**

## Config

Single env var in `.stack/.env`'s `#>--- localhost-proxy ---` block:

```
LOCALHOST_PROXY_PORTS=19299:19298,5433:5432
                      └ chrome ┘ └ pg ┘
                      <listen>:<target>
```

- `listen` = port on the proxy container (what the VM connects to)
- `target` = port on the Mac (what the proxy forwards to)
- Empty / unset = container sleeps (no listeners; no holes)
- The block is created on first use (either `just enable localhost-proxy`
  or `just chrome-cdp-enable` — whichever fires first). Once it exists,
  edit the line directly.
- Add a port = edit env, then `dc up -d --force-recreate localhost-proxy`
  (or re-run the consuming recipe).

## How VMs reach it

The proxy is on the project's orb network. From the VM:

- **orb DNS hostname** works for socket connectivity (`localhost-proxy.<project>.orb.local`).
- But — services like Chrome CDP reject HTTP requests whose `Host` header is a
  hostname (DNS-rebinding defense, Chrome 111+). Workaround: have the consuming
  recipe resolve the container's IP and hand that to the VM-side client. The IP
  literal in the URL → IP literal in the `Host` header → Chrome accepts.

`just chrome-cdp-enable` does this automatically and writes the URL into
`~/.hermes/.env` (via the hermes mount when `HERMES_MOUNT_ENABLED=true`).

## Lifecycle

Two valid states, distinguished by `COMPOSE_PROFILES`:

- **Persistent** — `just enable localhost-proxy` adds it to `COMPOSE_PROFILES`.
  Lives in the generated `docker-compose.yaml`; `dc up -d` brings it up like
  any other service. Survives `just stop && just start`.
- **Transient** — not in `COMPOSE_PROFILES`. `just chrome-cdp-enable` brings
  it up via an explicit `-f services/localhost-proxy/compose.yaml` flag (the
  generated compose doesn't include the service in this state).
  `chrome-cdp-disable` tears it down again.

`csv_add` / `csv_remove` on `LOCALHOST_PROXY_PORTS` is block-aware (via
`stack_upsert`) — chrome-cdp's `19299:19298` mapping is added/removed
without clobbering any user-added entries. Multiple consumers safe.
