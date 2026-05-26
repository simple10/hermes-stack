/**
 * Test fixture helper — create a fully-wired org without going through the
 * bootstrap endpoint (which can only run once per DB).
 *
 * Creates via direct Drizzle inserts:
 *   user + account + organization + member + PAT (apiKey row)
 *
 * Returns { userId, orgId, pat } so callers can authenticate as this org.
 */
import { drizzle } from 'drizzle-orm/d1'
import * as masterSchema from '../../src/db/master.ts'
import { mintApiKey } from '../../src/auth/api-keys.ts'
import { makeId } from '../../src/ids.ts'

const { user, account, organization, member } = masterSchema

export interface OrgFixture {
  userId: string
  orgId: string
  pat: string
}

/**
 * Create a test org fixture with a user, organization, member row, and PAT.
 *
 * @param db     - D1Database binding (the `(env.DB as D1Database)` from cloudflare:test)
 * @param name   - Human-readable org name (also used for user name)
 * @param slug   - Org slug — must be unique across the test run
 */
export async function createOrgFixture(
  db: D1Database,
  name: string,
  slug: string,
): Promise<OrgFixture> {
  const drizzleDb = drizzle(db, { schema: masterSchema })

  const userId = makeId('user')
  const orgId = makeId('org')
  const memberId = makeId('mbr')
  const accountId = makeId('acct')
  const now = new Date()
  const email = `${slug}-fixture@example.com`

  // Insert user.
  await drizzleDb.insert(user).values({
    id: userId,
    name,
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  })

  // Insert a credential account (needed for FK integrity in some better-auth flows,
  // though for API-key-only tests it's mostly for completeness).
  await drizzleDb.insert(account).values({
    id: accountId,
    userId,
    accountId: email,
    providerId: 'credential',
    password: 'hashed-for-test-only',
    createdAt: now,
    updatedAt: now,
  })

  // Insert organization.
  await drizzleDb.insert(organization).values({
    id: orgId,
    name,
    slug,
    createdAt: now,
    updatedAt: now,
  })

  // Insert member (owner).
  await drizzleDb.insert(member).values({
    id: memberId,
    organizationId: orgId,
    userId,
    role: 'owner',
    createdAt: now,
  })

  // Mint PAT.
  const { rawKey: pat } = await mintApiKey(drizzleDb as any, {
    prefix: 'mcpat_',
    name: `fixture PAT for ${slug}`,
    userId,
    orgId,
    principalType: 'pat',
  })

  return { userId, orgId, pat }
}

/**
 * Create a member (non-owner) fixture in an existing org.
 * Returns { userId, pat } for the new member.
 */
export async function createMemberFixture(
  db: D1Database,
  orgId: string,
  slug: string,
  role: 'admin' | 'member' = 'member',
): Promise<{ userId: string; pat: string }> {
  const drizzleDb = drizzle(db, { schema: masterSchema })

  const userId = makeId('user')
  const memberId = makeId('mbr')
  const accountId = makeId('acct')
  const now = new Date()
  const email = `${slug}-member@example.com`

  await drizzleDb.insert(user).values({
    id: userId,
    name: `Member ${slug}`,
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  })

  await drizzleDb.insert(account).values({
    id: accountId,
    userId,
    accountId: email,
    providerId: 'credential',
    password: 'hashed-for-test-only',
    createdAt: now,
    updatedAt: now,
  })

  await drizzleDb.insert(member).values({
    id: memberId,
    organizationId: orgId,
    userId,
    role,
    createdAt: now,
  })

  const { rawKey: pat } = await mintApiKey(drizzleDb as any, {
    prefix: 'mcpat_',
    name: `${role} PAT for ${slug}`,
    userId,
    orgId,
    principalType: 'pat',
  })

  return { userId, pat }
}
