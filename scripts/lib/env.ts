// env.ts — `.env` file IO.
//
// Two concerns separated:
//
//   parseEnvFile / parseEnvBody — STRUCTURED reads via the `dotenv` lib.
//     Handles quoting, multi-line single/double-quoted values, inline
//     `# comments`, etc. Use this when you need a flat Record<string,string>
//     of a file (or string body) — most callers should prefer it over
//     ad-hoc regex parsing.
//
//   envGet / envUpsert — LINE-ORIENTED reads/writes that preserve the
//     file's existing structure (comments, block markers, line order).
//     Used for in-place edits of .stack/.env, where structure
//     matters (the #>--- svc --- blocks are NOT ordinary env content).
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse as dotenvParse } from 'dotenv'

export const parseEnvBody = (body: string): Record<string, string> => dotenvParse(Buffer.from(body))

export const parseEnvFile = (file: string): Record<string, string> => {
  if (!existsSync(file)) return {}
  return dotenvParse(readFileSync(file))
}

// envGet — read a single KEY value via line-grep. Faster than parsing
// the whole file when you only need one value. Inline comments are NOT
// stripped here (caller can strip if needed; values may legitimately
// contain `#` — passwords, etc.). For full dict access, use parseEnvFile.
export const envGet = (file: string, key: string): string => {
  if (!existsSync(file)) return ''
  const body = readFileSync(file, 'utf8')
  const m = body.match(new RegExp(`^${escapeRe(key)}=(.*)$`, 'm'))
  return m ? m[1] : ''
}

// envUpsert — in-place line replacement (or append if absent). Preserves
// line position + surrounding comments.
export const envUpsert = (file: string, key: string, value: string): void => {
  mkdirSync(dirname(file), { recursive: true })
  const body = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lineRe = new RegExp(`^${escapeRe(key)}=.*$`, 'm')
  let next: string
  if (lineRe.test(body)) {
    next = body.replace(lineRe, `${key}=${value}`)
  } else {
    next = body.length === 0 || body.endsWith('\n') ? body : body + '\n'
    next += `${key}=${value}\n`
  }
  writeFileSync(file, next)
  chmodSync(file, 0o600)
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
