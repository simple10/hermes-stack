// generated.ts — read/write the per-service .generated.env in
// .stack/<svc>/.generated.env. These files hold machine-owned state
// (DB passwords, minted virtual keys, resolved digests, source SHAs).
// Never hand-edited.
import { randomBytes } from 'node:crypto'
import { mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { STACK_DIR } from './paths.ts'
import { envGet, envUpsert } from './env.ts'

export const generatedEnvPath = (svc: string): string => resolve(STACK_DIR, svc, '.generated.env')

export const ensureGeneratedDir = (svc: string): string => {
  const path = resolve(STACK_DIR, svc)
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
  return path
}

export const generatedGet = (svc: string, key: string): string => envGet(generatedEnvPath(svc), key)

export const generatedUpsert = (svc: string, key: string, value: string): void => {
  ensureGeneratedDir(svc)
  envUpsert(generatedEnvPath(svc), key, value)
}

// Generate a hex secret iff key is missing or empty. Returns true if it
// wrote a new value, false if it reused the existing one.
export const generatedGenIfMissing = (
  svc: string,
  key: string,
  prefix: string,
  bytes: number,
): boolean => {
  const cur = generatedGet(svc, key)
  if (cur) return false
  generatedUpsert(svc, key, prefix + randomBytes(bytes).toString('hex'))
  return true
}
