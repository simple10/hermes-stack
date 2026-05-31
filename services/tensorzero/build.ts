// tensorzero/build.ts — own the dedicated-Postgres password + stage the
// (non-secret) tensorzero.toml into .stack/ as the mounted runtime config.
// Pure image-pull service (no source build), so this is light.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { STACK_ROOT, STACK_DIR } from '../../scripts/lib/paths.ts'
import { generatedGenIfMissing } from '../../scripts/lib/generated.ts'
import { log } from '../../scripts/lib/log.ts'

export default async function build(): Promise<void> {
  // 1. Own TENSORZERO_DB_PASSWORD (decentralised; the dedicated tensorzero
  //    postgres is project-internal / orb-DNS-only).
  if (generatedGenIfMissing('tensorzero', 'TENSORZERO_DB_PASSWORD', '', 16)) {
    log('tensorzero: generated TENSORZERO_DB_PASSWORD')
  }

  // 2. Stage the committed config (no secrets — cliproxy key arrives via the
  //    gateway env) into the mounted runtime path under .stack/.
  const src = resolve(STACK_ROOT, 'services/tensorzero/config/tensorzero.toml')
  const out = resolve(STACK_DIR, 'tensorzero/tensorzero.toml')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, readFileSync(src, 'utf8'))
  log('tensorzero: staged tensorzero.toml (cliproxy models; key via env::CLIPROXY_API_KEY)')
}
