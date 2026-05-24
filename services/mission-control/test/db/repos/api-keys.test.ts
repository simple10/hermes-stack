/**
 * Unit tests for apiKeysRepo.
 *
 * Coverage:
 *   - findById returns the key scoped to ctx.orgId
 *   - findById returns null for a key in another org
 *   - listForUser returns only this user's keys within the org
 *   - mintForAgent mints a key with principalType='agent'
 *   - mintForConnector mints a key with principalType='connector'
 *   - mintForUser mints a key with principalType='pat'
 *   - revoke disables a key
 *   - lookupApiKey (static) looks up a key by its hashed token
 *   - lookupApiKeyById (static) looks up a key by its id
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { db } from '../../../src/db/repos/index.ts';
import { lookupApiKey, lookupApiKeyById } from '../../../src/db/repos/api-keys.ts';
import { hashKey } from '../../../src/auth/api-keys.ts';
import { createOrgFixture } from '../../helpers/orgs.ts';
import { ownerCtx, asOrgId } from './_ctx.ts';
import { makeId } from '../../../src/ids.ts';
import type { Env } from '../../../src/db/client.ts';

beforeAll(async () => {
  await applyD1Migrations((env.DB as D1Database), inject('d1Migrations') as D1Migration[]);
});

let slugN = 0;
function slug(prefix: string) { return `${prefix}-${++slugN}-apk`; }

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name));
  return { ...fix, orgId: asOrgId(fix.orgId) };
}

describe('apiKeysRepo', () => {
  it('mintForAgent mints a key with principalType=agent', async () => {
    const orgA = await makeOrg('apk-a');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const agentId = makeId('agent');
    const { id, rawKey } = await db.apiKeys(ctx).mintForAgent(agentId);
    expect(id).toBeDefined();
    expect(rawKey).toMatch(/^mcagt_/);
    const row = await db.apiKeys(ctx).findById(id);
    expect(row).not.toBeNull();
    expect(row!.principalType).toBe('agent');
    expect(row!.orgId).toBe(orgA.orgId);
  });

  it('mintForConnector mints a key with principalType=connector', async () => {
    const orgA = await makeOrg('apk-b');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const connectorId = makeId('cnn');
    const { id, rawKey } = await db.apiKeys(ctx).mintForConnector(connectorId);
    expect(rawKey).toMatch(/^mccnn_/);
    const row = await db.apiKeys(ctx).findById(id);
    expect(row!.principalType).toBe('connector');
  });

  it('mintForUser mints a PAT with principalType=pat', async () => {
    const orgA = await makeOrg('apk-c');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const { id, rawKey } = await db.apiKeys(ctx).mintForUser({
      prefix: 'mcpat_',
      name: 'Test PAT',
    });
    expect(rawKey).toMatch(/^mcpat_/);
    const row = await db.apiKeys(ctx).findById(id);
    expect(row!.principalType).toBe('pat');
  });

  it('findById returns null for a key in another org', async () => {
    const orgA = await makeOrg('apk-d');
    const orgB = await makeOrg('apk-e');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const { id } = await db.apiKeys(ctxA).mintForAgent(makeId('agent'));
    // Org B context cannot see Org A's key.
    expect(await db.apiKeys(ctxB).findById(id)).toBeNull();
  });

  it('listForUser returns only the specified user\'s keys in this org', async () => {
    const orgA = await makeOrg('apk-f');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    // Mint an agent key (userId=orgA.userId) and check listForUser.
    await db.apiKeys(ctx).mintForAgent(makeId('agent'));
    const list = await db.apiKeys(ctx).listForUser(orgA.userId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((k) => k.userId === orgA.userId)).toBe(true);
    expect(list.every((k) => k.orgId === orgA.orgId)).toBe(true);
  });

  it('revoke disables the key', async () => {
    const orgA = await makeOrg('apk-g');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const { id } = await db.apiKeys(ctx).mintForAgent(makeId('agent'));
    await db.apiKeys(ctx).revoke(id);
    const row = await db.apiKeys(ctx).findById(id);
    expect(row!.enabled).toBe(false);
  });

  it('lookupApiKey finds a key by its hashed token', async () => {
    const orgA = await makeOrg('apk-h');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const { id, rawKey } = await db.apiKeys(ctx).mintForAgent(makeId('agent'));
    const hashed = await hashKey(rawKey);
    const row = await lookupApiKey(env as unknown as Env, hashed);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
  });

  it('lookupApiKeyById finds a key by its id', async () => {
    const orgA = await makeOrg('apk-i');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const { id } = await db.apiKeys(ctx).mintForAgent(makeId('agent'));
    const row = await lookupApiKeyById(env as unknown as Env, id);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.orgId).toBe(orgA.orgId);
  });
});
