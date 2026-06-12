// cliproxyapi/build.ts — SEED config.yaml.template -> config.runtime.yaml ONCE
// (secrets injected from .stack/.env), then leave it alone.
//
// config.runtime.yaml is DASHBOARD-AUTHORITATIVE: CLIProxyAPI's management
// panel writes settings (file logging, plugins, OAuth providers, …) back to
// the bind-mounted config.yaml, and the app rewrites it on upgrades. So build
// must NOT re-render over the user's live config — it seeds when missing, and
// thereafter only WARNS if the committed template drifted (new upstream keys)
// so the user can reconcile. Reset path (re-seed from template):
//   rm .stack/cliproxyapi/config.runtime.yaml && stack-cli build
// (Same seed-once/drift-warn convention as lib/template.ts renderTemplate, but
// that one copies verbatim — cliproxy needs the __CLIPROXY_*__ substitution.)
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { STACK_ROOT, STACK_DIR } from '../../scripts/lib/paths.ts'
import { stackGet } from '../../scripts/lib/stack.ts'
import { substituteTemplate } from '../../scripts/lib/stack-env.ts'
import { die, log, warn } from '../../scripts/lib/log.ts'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

export default async function build(): Promise<void> {
  const apiKey = stackGet('CLIPROXY_API_KEY')
  const mgmtKey = stackGet('CLIPROXY_MANAGEMENT_KEY')
  if (!apiKey) die('CLIPROXY_API_KEY missing in .stack/.env (run: stack-cli setup)')
  if (!mgmtKey) die('CLIPROXY_MANAGEMENT_KEY missing in .stack/.env (run: stack-cli setup)')

  const svcDir = resolve(STACK_DIR, 'cliproxyapi')
  const out = resolve(svcDir, 'config.runtime.yaml')
  mkdirSync(svcDir, { recursive: true })
  // Persistent bind-mount targets: logs/ (file-logging output) + plugins/
  // (managed via the dashboard). Pre-create so the container writes into a
  // host-owned dir rather than a root-owned one Docker would auto-create.
  for (const sub of ['logs', 'plugins']) mkdirSync(resolve(svcDir, sub), { recursive: true })

  const tpl = resolve(STACK_ROOT, 'services/cliproxyapi/config.yaml.template')
  const tplBody = readFileSync(tpl, 'utf8')
  const hashFile = resolve(svcDir, '.config-hashes', 'config.runtime.yaml.sha256')
  const tplHash = sha256(tplBody)

  if (existsSync(out)) {
    if (!existsSync(hashFile)) {
      // Pre-existing config (seeded before hash tracking) — adopt it silently.
      mkdirSync(dirname(hashFile), { recursive: true })
      writeFileSync(hashFile, tplHash + '\n')
      log('cliproxyapi: config.runtime.yaml present + dashboard-authoritative (adopted)')
      return
    }
    if (readFileSync(hashFile, 'utf8').trim() !== tplHash) {
      warn('cliproxyapi: config.yaml.template changed since config.runtime.yaml was seeded.')
      warn('  Your live config is preserved (dashboard-authoritative). To adopt template')
      warn('  changes: reconcile by hand, or reset with')
      warn('  `rm .stack/cliproxyapi/config.runtime.yaml && stack-cli build`.')
    } else {
      log('cliproxyapi: config.runtime.yaml present + dashboard-authoritative (no template drift)')
    }
    return
  }

  const body = substituteTemplate(tplBody, { CLIPROXY_API_KEY: apiKey, CLIPROXY_MGMT_KEY: mgmtKey })
  writeFileSync(out, body)
  chmodSync(out, 0o600)
  mkdirSync(dirname(hashFile), { recursive: true })
  writeFileSync(hashFile, tplHash + '\n')
  log('cliproxyapi: seeded config.runtime.yaml from template (secrets injected; dashboard-authoritative thereafter)')
}
