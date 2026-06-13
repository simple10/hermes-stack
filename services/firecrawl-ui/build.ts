// firecrawl-ui/build.ts — fetch the pinned obeone/firecrawl-ui source, then
// build the image so the per-project API base URL (FIRECRAWL_API_BASE_URL
// build arg) is baked deterministically (multi-stack safe).
import { stackSource, consumeRebuildFlag } from '../../scripts/lib/source.ts'
import { dc } from '../../scripts/lib/dc.ts'
import { stackProject } from '../../scripts/lib/compose-env.ts'
import { log } from '../../scripts/lib/log.ts'

export default async function build(): Promise<void> {
  await stackSource('firecrawl-ui')
  if (consumeRebuildFlag('firecrawl-ui')) {
    log(
      `firecrawl-ui: source changed — building image ` +
        `(API base -> https://firecrawl-api.${stackProject()}.orb.local)`,
    )
    const r = await dc(['build', 'firecrawl-ui'])
    if (r.code !== 0) throw new Error('firecrawl-ui: dc build failed')
  } else {
    log('firecrawl-ui: source unchanged — skipping dc build')
  }
}
