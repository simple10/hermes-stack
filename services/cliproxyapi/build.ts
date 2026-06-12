// cliproxyapi/build.ts — seed config.runtime.yaml once, then keep only the
// STACK-OWNED keys in sync; everything else is DASHBOARD-authoritative.
//
// CLIProxyAPI has no env-var support (verified: it stores api-keys verbatim,
// no ${VAR} expansion), so secrets/ports/paths must be baked into config.yaml.
// The management panel rewrites that file, so build must NOT clobber it — but a
// few keys MUST track .stack/.env (or litellm↔cliproxy auth breaks on rotation).
// So: seed from the template when missing, then on every build force just the
// MANAGED keys via a generic YAML merge (lib/managed-config.ts). Add a future
// stack-owned key = one MANAGED entry. Warn on committed-template drift; reset =
//   rm .stack/cliproxyapi/config.runtime.yaml && stack-cli build
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { STACK_ROOT, STACK_DIR } from '../../scripts/lib/paths.ts'
import { stackGet } from '../../scripts/lib/stack.ts'
import { applyManagedKeys, type ManagedSpec } from '../../scripts/lib/managed-config.ts'
import { die, log, warn } from '../../scripts/lib/log.ts'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

// Stack-owned keys, force-synced from .stack/.env on every build. Editing these
// in the dashboard is pointless (overwritten here). Extend this list to manage
// more keys. NB: only keys CLIProxyAPI stores verbatim go here — secret-key is
// bcrypt-hashed by the app on startup, so it's handled by fingerprint below
// (force-syncing plaintext would churn against the hash every build).
const MANAGED: { path: (string | number)[]; value: () => unknown }[] = [
  { path: ['host'], value: () => '' },
  { path: ['port'], value: () => 8317 },
  { path: ['auth-dir'], value: () => '/root/.cli-proxy-api' },
  { path: ['api-keys'], value: () => [stackGet('CLIPROXY_API_KEY')] },
  { path: ['remote-management', 'allow-remote'], value: () => true },
  { path: ['plugins', 'enabled'], value: () => stackGet('CLIPROXY_PLUGINS_ENABLED') === 'true' },
  { path: ['plugins', 'dir'], value: () => 'plugins' },
]

export default async function build(): Promise<void> {
  if (!stackGet('CLIPROXY_API_KEY'))
    die('CLIPROXY_API_KEY missing in .stack/.env (run: stack-cli setup)')
  if (!stackGet('CLIPROXY_MANAGEMENT_KEY'))
    die('CLIPROXY_MANAGEMENT_KEY missing in .stack/.env (run: stack-cli setup)')

  const svcDir = resolve(STACK_DIR, 'cliproxyapi')
  const out = resolve(svcDir, 'config.runtime.yaml')
  mkdirSync(svcDir, { recursive: true })
  // Persistent bind-mount targets (logging-to-file output + plugins.dir).
  for (const sub of ['logs', 'plugins']) mkdirSync(resolve(svcDir, sub), { recursive: true })

  const tpl = resolve(STACK_ROOT, 'services/cliproxyapi/config.yaml.template')
  const tplBody = readFileSync(tpl, 'utf8')
  const hashFile = resolve(svcDir, '.config-hashes', 'config.runtime.yaml.sha256')
  const tplHash = sha256(tplBody)
  const seeding = !existsSync(out)

  const specs: ManagedSpec[] = MANAGED.map((m) => ({ path: m.path, value: m.value() }))

  // secret-key (CLIPROXY_MANAGEMENT_KEY) is bcrypt-hashed by CLIProxyAPI at
  // startup, so we can't plain-compare. Inject the plaintext only on SEED or
  // when the key ROTATED (fingerprint changed); otherwise adopt whatever's
  // there (the app's hash). Avoids per-build churn while still propagating a
  // rotated mgmt key.
  const mgmtKey = stackGet('CLIPROXY_MANAGEMENT_KEY')
  const fpFile = resolve(svcDir, '.config-hashes', 'mgmt-key.fp')
  const desiredFp = sha256(mgmtKey)
  const injectMgmt =
    seeding || (existsSync(fpFile) && readFileSync(fpFile, 'utf8').trim() !== desiredFp)
  if (injectMgmt) specs.push({ path: ['remote-management', 'secret-key'], value: mgmtKey })

  const base = seeding ? tplBody : readFileSync(out, 'utf8')
  const { yaml, changed } = applyManagedKeys(base, specs)

  if (seeding || changed) {
    writeFileSync(out, yaml)
    chmodSync(out, 0o600)
  }

  // Record the current mgmt-key fingerprint (adopts the existing key on first
  // run; detects rotation next time).
  mkdirSync(dirname(fpFile), { recursive: true })
  writeFileSync(fpFile, desiredFp + '\n')

  if (seeding) {
    mkdirSync(dirname(hashFile), { recursive: true })
    writeFileSync(hashFile, tplHash + '\n')
    log('cliproxyapi: seeded config.runtime.yaml from template (stack-owned keys injected)')
    return
  }

  // Existing config: dashboard-authoritative. We synced the managed keys above;
  // warn only if the committed template drifted (new upstream keys to adopt).
  if (!existsSync(hashFile)) {
    mkdirSync(dirname(hashFile), { recursive: true })
    writeFileSync(hashFile, tplHash + '\n')
  } else if (readFileSync(hashFile, 'utf8').trim() !== tplHash) {
    warn('cliproxyapi: config.yaml.template changed since config.runtime.yaml was seeded.')
    warn('  Stack-owned keys are still synced; your dashboard settings are preserved.')
    warn('  To adopt new template keys: reconcile by hand, or reset with')
    warn('  `rm .stack/cliproxyapi/config.runtime.yaml && stack-cli build`.')
  }
  log(
    changed
      ? 'cliproxyapi: synced stack-owned keys into config.runtime.yaml (dashboard settings preserved)'
      : 'cliproxyapi: config.runtime.yaml present + in sync (dashboard-authoritative)',
  )
}
