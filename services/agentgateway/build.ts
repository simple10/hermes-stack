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

// frontendPolicies.tracing -> Phoenix OTLP gRPC collector (gRPC default on 4317).
// Sampling is a CEL expression (eval_rng): a literal `true` => Bool(true) =>
// ALWAYS sample (100%), NOT a probability (only a float/int is treated as a
// rate). We set BOTH knobs to `true` so 100% of traces reach Phoenix:
//   - randomSampling: root requests (no inbound traceparent) — defaults to
//     DROP if unset, so this must be set.
//   - clientSampling: requests carrying an inbound traceparent — defaults to
//     true, but we set it explicitly so "log everything" is self-documenting.
// The `attributes` map emits OpenInference semantic-convention span attributes
// so Phoenix renders full LLM traces (prompts + completions), not just metadata.
// Mirrors agentgateway's own examples/telemetry/tracing/phoenix.yaml, translated
// to the frontendPolicies form (attributes: vs the deprecated fields.add:).
// llm.prompt (chat messages) + llm.completion are only buffered because these
// CEL exprs reference them. flattenRecursive expands them into the indexed
// OpenInference keys (llm.input_messages.N.message.{role,content}).
const PHOENIX_TRACING = `# Auto-injected by build.ts because the 'phoenix' service is enabled:
# export OTLP traces to Arize Phoenix at 100%, with OpenInference attributes so
# prompts/completions show in the Phoenix UI. Disabling phoenix + re-running
# 'stack-cli build' removes this block (hot-reloaded; no restart).
frontendPolicies:
  tracing:
    host: phoenix:4317
    randomSampling: true   # Bool(true) => always sample (100%), not a rate
    clientSampling: true   # also sample requests with an inbound traceparent
    attributes:
      span.name: '"openai.chat"'
      openinference.span.kind: '"LLM"'
      llm.system: 'llm.provider'
      llm.model_name: 'llm.responseModel'
      llm.input_messages: 'flattenRecursive(llm.prompt.map(c, {"message": c}))'
      llm.output_messages: 'flattenRecursive(llm.completion.map(c, {"role": "assistant", "content": c}))'
      llm.token_count.prompt: 'llm.inputTokens'
      llm.token_count.completion: 'llm.outputTokens'
      llm.token_count.total: 'llm.totalTokens'

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
