// health-rollup.test.ts — a "rollup" profile (firecrawl, honcho) owns several
// compose services (firecrawl-{api,postgres,playwright}); composeOwners maps
// each owned compose-service back to its profile so info doesn't show a phantom
// "missing" row for the profile name when the sub-services are running.
import { describe, expect, test, vi } from 'vitest'

const fresh = async (): Promise<typeof import('../lib/health.ts')> => {
  vi.resetModules()
  return import('../lib/health.ts')
}

describe('composeOwners', () => {
  test('rollup profile owns its compose services (firecrawl)', async () => {
    const { composeOwners } = await fresh()
    const { ownerOf, ownedByProfile } = composeOwners(['firecrawl', 'phoenix'])
    expect(ownerOf.get('firecrawl-api')).toBe('firecrawl')
    expect(ownerOf.get('firecrawl-postgres')).toBe('firecrawl')
    expect(ownerOf.get('firecrawl-playwright')).toBe('firecrawl')
    expect(ownedByProfile.get('firecrawl')).toEqual(
      expect.arrayContaining(['firecrawl-api', 'firecrawl-postgres', 'firecrawl-playwright']),
    )
  })

  test('single-service profile owns just itself, provisioners excluded (phoenix)', async () => {
    const { composeOwners } = await fresh()
    const { ownerOf, ownedByProfile } = composeOwners(['phoenix'])
    expect(ownerOf.get('phoenix')).toBe('phoenix')
    expect(ownedByProfile.get('phoenix')).toEqual(['phoenix']) // phoenix-provision excluded
  })
})
