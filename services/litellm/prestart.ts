// litellm/prestart.ts — fail loud BEFORE the heavy `up` if the rendered
// runtime config is missing or unparseable. Validation only; no side effects.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as yamlParse } from 'yaml'
import { STACK_DIR } from '../../scripts/lib/paths.ts'
import { die, log } from '../../scripts/lib/log.ts'

export default async function prestart(): Promise<void> {
  const cfg = resolve(STACK_DIR, 'litellm/config.runtime.yaml')
  if (!existsSync(cfg)) die(`litellm: ${cfg} missing — run: stack-cli build`)
  try {
    yamlParse(readFileSync(cfg, 'utf8'))
  } catch (err) {
    die(`litellm: ${cfg} is not valid YAML: ${(err as Error).message}`)
  }
  log('litellm/prestart: config.runtime.yaml present and parses')
}
