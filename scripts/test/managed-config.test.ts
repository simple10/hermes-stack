// managed-config.test.ts — generic "stack-owned keys" merge for user-editable
// YAML configs (e.g. cliproxy's dashboard-authoritative config.yaml). Sets a
// declared set of paths to stack values, preserving everything else + comments.
import { describe, expect, test } from 'vitest'
import { applyManagedKeys } from '../lib/managed-config.ts'

const SAMPLE = `# top comment
host: ""
remote-management:
  allow-remote: false
  secret-key: ""        # inline comment
api-keys:
  - "old-key"
# trailing comment
debug: false
`

describe('applyManagedKeys', () => {
  test('sets scalars + lists, reports changed', () => {
    const { yaml, changed } = applyManagedKeys(SAMPLE, [
      { path: ['remote-management', 'allow-remote'], value: true },
      { path: ['remote-management', 'secret-key'], value: 'sk-mgmt' },
      { path: ['api-keys'], value: ['sk-new'] },
    ])
    expect(changed).toBe(true)
    expect(yaml).toMatch(/allow-remote: true/)
    expect(yaml).toMatch(/secret-key: ['"]?sk-mgmt['"]?/)
    expect(yaml).toMatch(/- ['"]?sk-new['"]?/)
    expect(yaml).not.toMatch(/old-key/)
  })

  test('preserves comments + unmanaged keys', () => {
    const { yaml } = applyManagedKeys(SAMPLE, [
      { path: ['remote-management', 'secret-key'], value: 'sk-mgmt' },
    ])
    expect(yaml).toMatch(/# top comment/)
    expect(yaml).toMatch(/# inline comment/)
    expect(yaml).toMatch(/# trailing comment/)
    expect(yaml).toMatch(/debug: false/)
    expect(yaml).toMatch(/host: ""/)
  })

  test('creates a missing nested path', () => {
    const { yaml, changed } = applyManagedKeys(SAMPLE, [
      { path: ['plugins', 'enabled'], value: true },
      { path: ['plugins', 'dir'], value: 'plugins' },
    ])
    expect(changed).toBe(true)
    expect(yaml).toMatch(/plugins:/)
    expect(yaml).toMatch(/enabled: true/)
    expect(yaml).toMatch(/dir: ['"]?plugins['"]?/)
  })

  test('is idempotent — no change when values already match', () => {
    const { yaml, changed } = applyManagedKeys(SAMPLE, [
      { path: ['host'], value: '' },
      { path: ['debug'], value: false },
      { path: ['api-keys'], value: ['old-key'] },
    ])
    expect(changed).toBe(false)
    expect(yaml).toBe(SAMPLE)
  })
})
