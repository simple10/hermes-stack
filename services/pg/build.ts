// pg/build.ts — generate ONLY the superuser password into
// .stack-node/pg/.generated.env. Per-service DB passwords are
// decentralized: each pg-using service owns its own <SVC>_DB_PASSWORD
// in .stack-node/<svc>/.generated.env, set by its own build.ts.
//
// Reused on re-run so the value keeps matching the project's pg data
// volume — rotating it after the volume exists would break auth.
import { generatedGenIfMissing } from '../../scripts/lib/generated.ts'
import { log } from '../../scripts/lib/log.ts'

export default async function build(): Promise<void> {
  if (generatedGenIfMissing('pg', 'POSTGRES_SUPERPASS', '', 16)) {
    log('postgres: generated POSTGRES_SUPERPASS')
  } else {
    log('postgres: reusing existing POSTGRES_SUPERPASS (keeps matching pg volume)')
  }
}
