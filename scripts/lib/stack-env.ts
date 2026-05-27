// stack-env.ts — load + expand the full .stack-node/.env (including all
// .stack-node/*/.generated.env overlays) into a flat Record<string,string>.
// Used by service build.ts modules that need to substitute ${VAR}-style
// references inside templates (the bash version did this by `set -a; .
// .stack/.env; set +a`).
//
// Expansion is single-pass with dotenv-expand. Cycles are tolerated
// (dotenv-expand leaves them literal).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import dotenv from 'dotenv'
import dotenvExpand from 'dotenv-expand'
import { STACK_DIR, STACK_ENV } from './paths.ts'

export const loadStackEnv = (): Record<string, string> => {
  const acc: Record<string, string> = {}
  const merge = (path: string): void => {
    if (!existsSync(path)) return
    const parsed = dotenv.parse(readFileSync(path))
    for (const [k, v] of Object.entries(parsed)) acc[k] = v
  }
  merge(STACK_ENV)
  if (existsSync(STACK_DIR)) {
    for (const sub of readdirSync(STACK_DIR)) {
      const dir = resolve(STACK_DIR, sub)
      if (!statSync(dir).isDirectory()) continue
      merge(resolve(dir, '.generated.env'))
    }
  }
  // dotenv-expand mutates a { parsed } object in place.
  const expanded = dotenvExpand.expand({ parsed: acc, processEnv: {} }).parsed ?? {}
  return expanded
}

// substituteTemplate — replace __KEY__ placeholders in `body` with values
// from `env`. Missing keys become `fallback[key]` if provided, else "".
// Mirrors the sed-replace pattern in the bash build.sh files.
export const substituteTemplate = (
  body: string,
  env: Record<string, string>,
  fallback: Record<string, string> = {},
): string => body.replace(/__([A-Z][A-Z0-9_]*)__/g, (_, key) => env[key] ?? fallback[key] ?? '')
