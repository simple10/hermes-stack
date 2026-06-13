// firecrawl/build.ts — pin the firecrawl monorepo at FIRECRAWL_VERSION, then
// build all three services (api + playwright + nuq-postgres) from _source so
// they stay version-coherent. Also owns FIRECRAWL_DB_PASSWORD +
// FIRECRAWL_BULL_AUTH_KEY (decentralized; firecrawl is otherwise all-env).
import { stackSource, consumeRebuildFlag } from '../../scripts/lib/source.ts'
import { dc } from '../../scripts/lib/dc.ts'
import { generatedGenIfMissing } from '../../scripts/lib/generated.ts'
import { log } from '../../scripts/lib/log.ts'

export default async function build(): Promise<void> {
  generatedGenIfMissing('firecrawl', 'FIRECRAWL_DB_PASSWORD', '', 16)
  generatedGenIfMissing('firecrawl', 'FIRECRAWL_BULL_AUTH_KEY', '', 16)

  await stackSource('firecrawl')
  if (consumeRebuildFlag('firecrawl')) {
    log(
      'firecrawl: source changed — building api + playwright + nuq-postgres from ' +
        '_source (Chromium pull; can take several minutes)',
    )
    const r = await dc(['build', 'firecrawl-postgres', 'firecrawl-playwright', 'firecrawl-api'])
    if (r.code !== 0) throw new Error('firecrawl: dc build failed')
  } else {
    log('firecrawl: source unchanged — skipping image build')
  }
}
