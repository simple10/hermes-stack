// hermes-env.ts — manage the ~/.hermes/.env "managed block".
//
// hermes-stack owns a single block delimited by MANAGED_OPEN/_CLOSE.
// Lines OUTSIDE that block are user-owned and preserved across every
// `stack-cli build`. Mirrors the `#>--- svc ---` block idiom used in
// .stack-node/.env and the bash hermes_env_rewrite_managed_block.
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { warn } from './log.ts'

export const MANAGED_OPEN =
  '# >>> hermes-stack managed (rewritten on each `stack-cli build`) -- DO NOT EDIT >>>'
export const MANAGED_CLOSE = '# <<< hermes-stack managed <<<'
const MANAGED_HINT =
  '# User vars below are preserved across `stack-cli build`. Add plugin env (e.g. HERMES_AGENTS_OBSERVE_URL) here.'

// extractManagedKeys — return the set of KEY names declared at the start
// of each line in `content` (KEY=...). Used to scrub stale top-level
// assignments during migration.
const extractManagedKeys = (content: string): Set<string> => {
  const keys = new Set<string>()
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/)
    if (m) keys.add(m[1])
  }
  return keys
}

const trimBlankEdges = (s: string): string => {
  const lines = s.split('\n')
  let i = 0,
    j = lines.length - 1
  while (i <= j && lines[i].trim() === '') i++
  while (j >= i && lines[j].trim() === '') j--
  return lines.slice(i, j + 1).join('\n')
}

// Rewrite the managed block in `target` (path to ~/.hermes/.env on the
// Mac side when mount is enabled). Three modes:
//   first   — file missing: just the managed block, no hint.
//   migrate — file exists with no markers: existing content becomes the
//             user section, scrubbed of any key managed-block now owns.
//   update  — markers present: replace only the content between them.
export const writeManagedBlock = (target: string, content: string): void => {
  mkdirSync(dirname(target), { recursive: true })
  let mode: 'first' | 'migrate' | 'update' = 'first'
  let pre = ''
  let post = ''

  if (existsSync(target)) {
    const body = readFileSync(target, 'utf8')
    const lines = body.split('\n')
    const openIdx = lines.findIndex((l) => l === MANAGED_OPEN)
    const closeIdx = lines.findIndex((l) => l === MANAGED_CLOSE)
    if (openIdx >= 0 && closeIdx > openIdx) {
      mode = 'update'
      pre = lines.slice(0, openIdx).join('\n')
      post = lines.slice(closeIdx + 1).join('\n')
    } else {
      if (openIdx >= 0 || closeIdx >= 0) {
        warn(
          '~/.hermes/.env: marker pair incomplete — treating entire file as user data and reinserting fresh markers',
        )
      }
      mode = 'migrate'
      const managed = extractManagedKeys(content)
      post = lines
        .filter((line) => {
          const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=/)
          return !(m && managed.has(m[1]))
        })
        .join('\n')
    }
  }

  const postClean = trimBlankEdges(post)
  const out: string[] = []
  if (pre) out.push(pre)
  out.push(MANAGED_OPEN)
  out.push(content)
  out.push(MANAGED_CLOSE)
  if (mode === 'migrate') {
    out.push('', MANAGED_HINT)
  }
  if (postClean) {
    if (mode === 'update') out.push('')
    out.push(postClean)
  }
  writeFileSync(target, out.join('\n') + '\n')
  chmodSync(target, 0o600)
}
