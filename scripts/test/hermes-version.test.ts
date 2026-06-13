// hermes-version.test.ts — parse `hermes --version` output.
import { describe, expect, test } from 'vitest'
import { parseHermesVersion } from '../../services/hermes/hermes-version.ts'

const FULL = `Hermes Agent v0.16.0 (2026.6.5) · upstream 9688c1a9
Project: /opt/hermes-agent
Python: 3.11.15
OpenAI SDK: 2.24.0
Update available: 37 commits behind — run 'hermes update'`

describe('parseHermesVersion', () => {
  test('extracts the version from the first line', () => {
    expect(parseHermesVersion(FULL).version).toBe('0.16.0')
  })

  test('extracts the commits-behind count when an update is available', () => {
    expect(parseHermesVersion(FULL).behind).toBe(37)
  })

  test('up-to-date output has no behind count', () => {
    const out = 'Hermes Agent v0.16.0 (2026.6.5) · upstream 9688c1a9\nProject: /opt/hermes-agent'
    const r = parseHermesVersion(out)
    expect(r.version).toBe('0.16.0')
    expect(r.behind).toBeNull()
  })

  test('singular "1 commit behind" parses', () => {
    const out = "Hermes Agent v0.16.0\nUpdate available: 1 commit behind — run 'hermes update'"
    expect(parseHermesVersion(out).behind).toBe(1)
  })

  test('empty / garbage output yields empty version and null behind', () => {
    expect(parseHermesVersion('')).toEqual({ version: '', behind: null })
    expect(parseHermesVersion('something unrelated')).toEqual({ version: '', behind: null })
  })
})
