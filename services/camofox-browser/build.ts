// camofox-browser/build.ts — own CAMOFOX_ACCESS_KEY (decentralized,
// gen-once) + fetch pinned _source + eager image build. Standalone
// service: no backend deps, no preflight/prestart.
import { stackGet } from '../../scripts/lib/stack.ts'
import { stackSource, consumeRebuildFlag } from '../../scripts/lib/source.ts'
import {
  generatedGet,
  generatedUpsert,
  generatedGenIfMissing,
} from '../../scripts/lib/generated.ts'
import { dc } from '../../scripts/lib/dc.ts'
import { log } from '../../scripts/lib/log.ts'

export default async function build(): Promise<void> {
  const authMode = stackGet('CAMOFOX_AUTH')
  if (authMode === 'disabled') {
    generatedUpsert('camofox-browser', 'CAMOFOX_ACCESS_KEY', '')
    log(
      'camofox-browser: CAMOFOX_AUTH=disabled — server runs without bearer auth (Hermes-compatible)',
    )
  } else {
    if (generatedGenIfMissing('camofox-browser', 'CAMOFOX_ACCESS_KEY', '', 32)) {
      log('camofox-browser: CAMOFOX_ACCESS_KEY generated')
    } else {
      log(
        'camofox-browser: CAMOFOX_ACCESS_KEY owned (reused; set CAMOFOX_AUTH=disabled to drop bearer auth)',
      )
    }
    void generatedGet // unused; silence linter without removing import for symmetry
  }

  await stackSource('camofox-browser')

  if (consumeRebuildFlag('camofox-browser')) {
    log('camofox-browser: source changed — building image (Dockerfile.ci)')
    const r = await dc(['build', 'camofox-browser'])
    if (r.code !== 0) throw new Error('camofox-browser: dc build failed')
  } else {
    log('camofox-browser: source unchanged — skipping dc build')
  }
}
