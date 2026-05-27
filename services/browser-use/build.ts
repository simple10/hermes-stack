// browser-use/build.ts — fetch pinned upstream source, then build the
// image via the UPSTREAM Dockerfile (bundles python3.12 + uv + system
// Chromium). _source/ stays pristine; runtime config is via compose env.
import { stackSource, consumeRebuildFlag } from '../../scripts/lib/source.ts'
import { dc } from '../../scripts/lib/dc.ts'
import { log } from '../../scripts/lib/log.ts'

export default async function build(): Promise<void> {
  await stackSource('browser-use')
  if (consumeRebuildFlag('browser-use')) {
    log('browser-use: source changed — building image (upstream Dockerfile; Chromium + uv bundled)')
    const r = await dc(['build', 'browser-use'])
    if (r.code !== 0) throw new Error('browser-use: dc build failed')
  } else {
    log('browser-use: source unchanged — skipping dc build')
  }
}
