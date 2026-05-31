// portkey/build.ts — pin source + render conf.json (with admin_token) and
// bake it into the image. The Portkey gateway bundles conf.json at COMPILE
// time (rollup inlines `import conf from '../conf.json'`), so the admin_token
// that unlocks the console UI cannot be supplied at runtime — it must be
// present in _source/conf.json BEFORE the image build. We therefore render our
// conf.json INTO _source and rebuild whenever the source pin OR the rendered
// conf changes. Source-build idiom mirrors honcho/build.ts.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { STACK_ROOT, STACK_DIR } from '../../scripts/lib/paths.ts'
import { stackSource, consumeRebuildFlag } from '../../scripts/lib/source.ts'
import { loadStackEnv, substituteTemplate } from '../../scripts/lib/stack-env.ts'
import { generatedGenIfMissing } from '../../scripts/lib/generated.ts'
import { dc } from '../../scripts/lib/dc.ts'
import { log } from '../../scripts/lib/log.ts'

export default async function build(): Promise<void> {
  // 1. Pin source (sets the rebuild flag if the checkout moved).
  await stackSource('portkey')

  // 2. Own the admin token (decentralised, gen-once) — gates the console UI.
  if (generatedGenIfMissing('portkey', 'PORTKEY_ADMIN_TOKEN', '', 24)) {
    log('portkey: generated PORTKEY_ADMIN_TOKEN')
  }

  // 3. Render conf.json with the admin token injected. Keep a copy in .stack/
  //    as the readable source-of-truth, and write it into _source/ as the
  //    build input the upstream Dockerfile's `COPY . .` bakes in.
  const env = loadStackEnv() // merges .stack/.env + .stack/*/.generated.env
  const tpl = resolve(STACK_ROOT, 'services/portkey/conf.json.template')
  const body = substituteTemplate(readFileSync(tpl, 'utf8'), env)

  const stackCopy = resolve(STACK_DIR, 'portkey/conf.json')
  mkdirSync(dirname(stackCopy), { recursive: true })
  writeFileSync(stackCopy, body)

  const baked = resolve(STACK_ROOT, 'services/portkey/_source/conf.json')
  const prevBaked = existsSync(baked) ? readFileSync(baked, 'utf8') : ''
  const confChanged = prevBaked !== body
  if (confChanged) writeFileSync(baked, body)
  log(`portkey: rendered conf.json (admin_token injected)${confChanged ? ' — changed' : ''}`)

  // 4. Rebuild when the source moved OR conf.json changed (the token is baked,
  //    so a token/conf change without a source bump still needs a rebuild).
  const sourceChanged = consumeRebuildFlag('portkey')
  if (sourceChanged || confChanged) {
    log(`portkey: ${sourceChanged ? 'source' : 'conf'} changed — building image`)
    const res = await dc(['build', 'portkey'])
    if (res.code !== 0) throw new Error('portkey: dc build failed')
  } else {
    log('portkey: source + conf unchanged — skipping dc build')
  }
}
