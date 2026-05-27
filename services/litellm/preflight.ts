// litellm/preflight.ts — run BEFORE the main `up`. Brings litellm up,
// waits for /health/liveliness, then idempotently mints one UNRESTRICTED
// virtual key per LITELLM_VIRTKEYS alias and writes <ALIAS>_VIRTUAL_KEY
// into .stack-node/litellm/.generated.env.
//
// Multi-stack safe: reaches LiteLLM via OrbStack DNS
// (`litellm.<project>.orb.local:4000`) — no fixed container name, no
// shared network. The admin master key is read from the project's
// .stack-node/.env (top-level, owned by `./stack-cli setup`).
//
// Self-heals (gotcha #4): if a stored virtual key isn't valid in THIS DB
// (fresh pg / rotated / volume recreated) the /key/update probe fails
// and we re-mint, overwriting the stale value in .generated.env.
import { dc } from '../../scripts/lib/dc.ts'
import { stackProject } from '../../scripts/lib/compose-env.ts'
import { stackGet } from '../../scripts/lib/stack.ts'
import { generatedGet, generatedUpsert } from '../../scripts/lib/generated.ts'
import { waitForOk, jsonRequest } from '../../scripts/lib/http.ts'
import { die, log, warn } from '../../scripts/lib/log.ts'

export default async function preflight(): Promise<void> {
  log('litellm/preflight: dc up -d litellm')
  const up = await dc(['up', '-d', 'litellm'])
  if (up.code !== 0) die('litellm/preflight: `dc up -d litellm` failed')

  const base = `http://litellm.${stackProject()}.orb.local:4000`
  log(`litellm/preflight: waiting for ${base}/health/liveliness …`)
  const ok = await waitForOk(`${base}/health/liveliness`, {
    timeoutMs: 4 * 60_000,
    intervalMs: 5_000,
  })
  if (!ok) die(`litellm not serving /health/liveliness after ~4min (${base})`)

  const masterKey = stackGet('LITELLM_MASTER_KEY')
  if (!masterKey) die('LITELLM_MASTER_KEY empty in .stack-node/.env (run: stack-cli setup)')
  const aliases = (stackGet('LITELLM_VIRTKEYS') || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  if (aliases.length === 0) die('LITELLM_VIRTKEYS empty in .stack-node/.env (run: stack-cli setup)')

  for (const raw of aliases) {
    const alias = raw.toLowerCase().replace(/-/g, '_')
    if (!alias) continue
    const envKey = `${alias.toUpperCase()}_VIRTUAL_KEY`
    const existing = generatedGet('litellm', envKey)
    if (existing) {
      // Probe /key/update — if it 404s the key isn't in this DB.
      try {
        await jsonRequest(`${base}/key/update`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${masterKey}` },
          body: { key: existing, models: [] },
        })
        log(`litellm: ${alias} key present (unrestricted)`)
        continue
      } catch {
        warn(`litellm: ${alias} key not in this db (fresh/rotated) — re-minting`)
      }
    }
    const res = await jsonRequest<{ key: string }>(`${base}/key/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${masterKey}` },
      body: { key_alias: alias, models: [] },
    })
    if (!res.key) die(`litellm: failed to mint key for ${alias}`)
    generatedUpsert('litellm', envKey, res.key)
    log(`litellm: minted ${envKey} (alias=${alias})`)
  }
}
