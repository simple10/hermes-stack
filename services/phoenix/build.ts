// phoenix/build.ts — own the phoenix role password on the shared pg.
// Pure image-pull service; Phoenix is env-configured and runs its own
// migrations, so there's no config file to render.
import { generatedGenIfMissing } from '../../scripts/lib/generated.ts'
import { log } from '../../scripts/lib/log.ts'

export default async function build(): Promise<void> {
  if (generatedGenIfMissing('phoenix', 'PHOENIX_DB_PASSWORD', '', 16)) {
    log('phoenix: generated PHOENIX_DB_PASSWORD')
  }
}
