// agentgateway/build.ts — render config.yaml.template -> config.runtime.yaml
// with the cliproxy client key injected from .stack/.env. agentgateway reads
// its config from a file (-f), so the rendered runtime file carries the key
// (gitignored under .stack/). Mirrors cliproxyapi/build.ts.
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { STACK_ROOT, STACK_DIR } from '../../scripts/lib/paths.ts'
import { stackGet } from '../../scripts/lib/stack.ts'
import { substituteTemplate } from '../../scripts/lib/stack-env.ts'
import { die, log } from '../../scripts/lib/log.ts'

export default async function build(): Promise<void> {
  const apiKey = stackGet('CLIPROXY_API_KEY')
  if (!apiKey)
    die('CLIPROXY_API_KEY missing in .stack/.env (enable cliproxyapi + run: stack-cli setup)')
  const tpl = resolve(STACK_ROOT, 'services/agentgateway/config.yaml.template')
  const out = resolve(STACK_DIR, 'agentgateway/config.runtime.yaml')
  mkdirSync(dirname(out), { recursive: true })
  const body = substituteTemplate(readFileSync(tpl, 'utf8'), {
    CLIPROXY_API_KEY: apiKey,
  })
  writeFileSync(out, body)
  chmodSync(out, 0o600)
  log('agentgateway: rendered config.runtime.yaml (cliproxy key injected from .stack/.env)')
}
