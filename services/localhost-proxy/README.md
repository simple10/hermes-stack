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

Single env var in `.stack/.env`:

```
LOCALHOST_PROXY_PORTS=19299:19298,5433:5432
                      └ chrome ┘ └ pg ┘
                      <listen>:<target>
```

- `listen` = port on the proxy container (what the VM connects to)
- `target` = port on the Mac (what the proxy forwards to)
- Empty / unset = container sleeps (no listeners; no holes)
- Add a port = edit env, then `dc up -d localhost-proxy` (or re-run the
  consuming recipe, e.g. `just chrome-cdp`).

## How VMs reach it

The proxy is on the project's orb network. From the VM:

- **orb DNS hostname** works for socket connectivity (`localhost-proxy.<project>.orb.local`).
- But — services like Chrome CDP reject HTTP requests whose `Host` header is a
  hostname (DNS-rebinding defense, Chrome 111+). Workaround: have the consuming
  recipe resolve the container's IP and hand that to the VM-side client. The IP
  literal in the URL → IP literal in the `Host` header → Chrome accepts.

`just chrome-cdp` does this automatically and prints the URL ready to paste
into `~/.hermes/.env` (or `hermes config set browser.cdp_url`).

## Lifecycle

Owned by whichever recipe needs host bridging. Currently `just chrome-cdp`
brings it up; `just chrome-cdp-stop` tears it down. Multiple recipes can share
it — `dc up -d localhost-proxy` is idempotent, and the port list grows in
`.stack/.env`.
