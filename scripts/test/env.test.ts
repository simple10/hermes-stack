// env.test.ts — sanity-check line-oriented envGet/envUpsert and
// dotenv-backed parseEnvFile/parseEnvBody.
import { describe, expect, test, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { envGet, envUpsert, parseEnvFile, parseEnvBody } from '../lib/env.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'stackenv-'))
})

describe('envGet / envUpsert', () => {
  test('upserts a new KEY by appending', () => {
    const f = resolve(dir, 'a.env')
    envUpsert(f, 'FOO', 'bar')
    expect(readFileSync(f, 'utf8')).toBe('FOO=bar\n')
    expect(envGet(f, 'FOO')).toBe('bar')
  })

  test('upserts an existing KEY in place, preserving surrounding lines', () => {
    const f = resolve(dir, 'b.env')
    writeFileSync(f, '# header comment\n' + 'FOO=old\n' + 'BAR=keep\n' + '# trailing comment\n')
    envUpsert(f, 'FOO', 'new')
    expect(readFileSync(f, 'utf8')).toBe(
      '# header comment\n' + 'FOO=new\n' + 'BAR=keep\n' + '# trailing comment\n',
    )
  })

  test('envGet returns empty string when key missing or file missing', () => {
    expect(envGet(resolve(dir, 'missing.env'), 'ANY')).toBe('')
    const f = resolve(dir, 'x.env')
    writeFileSync(f, 'OTHER=ok\n')
    expect(envGet(f, 'MISSING')).toBe('')
  })

  test('creates parent dir for envUpsert', () => {
    const f = resolve(dir, 'deep/nested/path.env')
    envUpsert(f, 'KEY', 'value')
    expect(readFileSync(f, 'utf8')).toBe('KEY=value\n')
  })
})

describe('parseEnv (dotenv-backed)', () => {
  test('strips inline comments + handles quoted multi-line values', () => {
    const body = `# header
FOO=bar             # trailing comment ignored
QUOTED='line1
line2
line3'
PASSWORD="p#with#hash"
`
    const m = parseEnvBody(body)
    expect(m.FOO).toBe('bar')
    expect(m.QUOTED).toBe('line1\nline2\nline3')
    // dotenv preserves '#' inside double-quoted strings:
    expect(m.PASSWORD).toBe('p#with#hash')
  })

  test('parseEnvFile returns {} for missing file', () => {
    mkdirSync(dir, { recursive: true })
    expect(parseEnvFile(resolve(dir, 'nope.env'))).toEqual({})
  })
})
