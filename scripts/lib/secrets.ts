// secrets.ts — gen-once secret helpers. Stable across re-runs: if the
// value already exists in .stack/.env, leave it.
import { randomBytes } from 'node:crypto'
import { stackGet, stackUpsert } from './stack.ts'

export const genIfMissing = (key: string, prefix: string, bytes: number): boolean => {
  const cur = stackGet(key)
  if (cur) return false
  const value = prefix + randomBytes(bytes).toString('hex')
  stackUpsert(key, value)
  return true
}
