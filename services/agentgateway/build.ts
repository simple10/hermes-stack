// agentgateway/build.ts — render config.yaml.template -> config.runtime.yaml
// with the cliproxy client key injected from .stack/.env. agentgateway reads
// its config from a file (-f), so the rendered runtime file carries the key
// (gitignored under .stack/). Mirrors cliproxyapi/build.ts.
//
// Observability auto-wiring: when the `phoenix` service is enabled, we prepend
// a frontendPolicies.tracing block exporting OTLP traces (gen_ai spans) to
// phoenix:4317. Toggling phoenix + re-running `stack-cli build` re-renders
// this file; agentgateway's config watcher hot-reloads it (no restart).
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { STACK_ROOT, STACK_DIR } from '../../scripts/lib/paths.ts'
import { stackGet } from '../../scripts/lib/stack.ts'
import { substituteTemplate } from '../../scripts/lib/stack-env.ts'
import { stackProfiles } from '../../scripts/lib/compose-env.ts'
import { die, log } from '../../scripts/lib/log.ts'

// frontendPolicies.tracing -> Phoenix OTLP gRPC collector. Matches the form in
// agentgateway's telemetry example (host + randomSampling; gRPC default on 4317).
const PHOENIX_TRACING = `# Auto-injected by build.ts because the 'phoenix' service is enabled:
# export OTLP traces (gen_ai spans) to Arize Phoenix's collector. Disabling
# phoenix + re-running 'stack-cli build' removes this block (hot-reloaded).
frontendPolicies:
  tracing:
    host: phoenix:4317
    randomSampling: true

`

export default async function build(): Promise<void> {
  const apiKey = stackGet('CLIPROXY_API_KEY')
  if (!apiKey)
    die('CLIPROXY_API_KEY missing in .stack/.env (enable cliproxyapi + run: stack-cli setup)')
  const tpl = resolve(STACK_ROOT, 'services/agentgateway/config.yaml.template')
  const out = resolve(STACK_DIR, 'agentgateway/config.runtime.yaml')
  mkdirSync(dirname(out), { recursive: true })
  let body = substituteTemplate(readFileSync(tpl, 'utf8'), {
    CLIPROXY_API_KEY: apiKey,
  })
  // Auto-wire Phoenix as the tracing backend iff it's enabled in the stack.
  const phoenixEnabled = stackProfiles()
    .split(',')
    .map((x) => x.trim())
    .includes('phoenix')
  if (phoenixEnabled) body = PHOENIX_TRACING + body
  writeFileSync(out, body)
  chmodSync(out, 0o600)
  log(
    `agentgateway: rendered config.runtime.yaml (cliproxy key injected` +
      `${phoenixEnabled ? '; tracing -> phoenix:4317' : ''})`,
  )
}
