// version-hook.test.ts — the optional per-service version hook loader.
import { describe, expect, test } from 'vitest'
import { hasVersionHook, serviceVersionHook } from '../lib/svc.ts'

describe('serviceVersionHook', () => {
  test('hermes provides a version.ts hook', () => {
    expect(hasVersionHook('hermes')).toBe(true)
  })

  test('a service without version.ts has no hook', async () => {
    expect(hasVersionHook('redis')).toBe(false)
    expect(await serviceVersionHook('redis')).toBeNull()
  })
})
