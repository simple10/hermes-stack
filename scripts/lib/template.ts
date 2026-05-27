// template.ts — mirror render_template in lib/stacklib.sh.
//
//   - First render: copy TEMPLATE -> OUT verbatim, record sha256.
//   - Subsequent: if OUT exists AND the TEMPLATE's sha256 has drifted
//     since the recorded one, warn (no overwrite — user-applied edits
//     in OUT are preserved). User re-renders with `stack-cli reconfigure`.
//   - No drift -> silent (just a "present and up to date" log).
//
// State lives in .stack-node/<svc>/.config-hashes/<basename>.sha256.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { STACK_DIR } from './paths.ts'
import { log, warn } from './log.ts'

const sha256 = (file: string): string => {
  const h = createHash('sha256')
  h.update(readFileSync(file))
  return h.digest('hex')
}

export const renderTemplate = (template: string, output: string, svc: string): void => {
  if (!existsSync(template)) throw new Error(`renderTemplate: missing template ${template}`)
  mkdirSync(dirname(output), { recursive: true })
  const hashDir = resolve(STACK_DIR, svc, '.config-hashes')
  mkdirSync(hashDir, { recursive: true })
  const hashFile = resolve(hashDir, basename(output) + '.sha256')
  const cur = sha256(template)
  if (!existsSync(output)) {
    copyFileSync(template, output)
    writeFileSync(hashFile, cur + '\n')
    log(`rendered ${output} from ${basename(template)}`)
    return
  }
  const rec = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : 'none'
  if (cur !== rec) {
    warn(`${svc}: ${basename(template)} changed since ${basename(output)} was rendered.`)
    warn(`  Review changes and re-render with: stack-cli reconfigure ${svc}`)
  } else {
    log(`${output} present and up to date (no template drift)`)
  }
  // unused but kept for parity with bash 'statSync' debugging path
  void statSync
}

// forceRender — overwrite OUT from TEMPLATE + update the hash record.
// Used by `stack-cli reconfigure <svc>`.
export const forceRender = (template: string, output: string, svc: string): void => {
  if (!existsSync(template)) throw new Error(`forceRender: missing template ${template}`)
  mkdirSync(dirname(output), { recursive: true })
  const hashDir = resolve(STACK_DIR, svc, '.config-hashes')
  mkdirSync(hashDir, { recursive: true })
  const hashFile = resolve(hashDir, basename(output) + '.sha256')
  copyFileSync(template, output)
  writeFileSync(hashFile, sha256(template) + '\n')
  log(`re-rendered ${output} from ${basename(template)}`)
}
