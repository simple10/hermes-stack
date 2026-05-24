/**
 * Unit tests for connectorsRepo.
 *
 * Coverage:
 *   - insert stamps orgId from ctx
 *   - findById returns row in same org
 *   - findById returns null for cross-org id
 *   - update with cross-org id returns null
 *   - softDelete with cross-org id returns null
 *   - softDelete with actor override writes system deleter
 *   - list returns only this org's connectors
 *   - DuplicateError thrown on name collision within the same org
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { db } from '../../../src/db/repos/index.ts';
import { DuplicateError } from '../../../src/db/repos/_errors.ts';
import { createOrgFixture } from '../../helpers/orgs.ts';
import { ownerCtx, asOrgId } from './_ctx.ts';
import type { Env } from '../../../src/db/client.ts';

beforeAll(async () => {
  await applyD1Migrations((env.DB as D1Database), inject('d1Migrations') as D1Migration[]);
});

let slugN = 0;
function slug(prefix: string) { return `${prefix}-${++slugN}-cnn`; }

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name));
  return { ...fix, orgId: asOrgId(fix.orgId) };
}

describe('connectorsRepo', () => {
  it('insert stamps orgId from ctx', async () => {
    const orgA = await makeOrg('cnn-a');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const connector = await db.connectors(ctx).insert({ name: 'Notion', kind: 'notion', createdByUserId: orgA.userId });
    expect(connector.orgId).toBe(orgA.orgId);
    expect(connector.id).toMatch(/^cnn_/);
  });

  it('findById returns the row in the same org', async () => {
    const orgA = await makeOrg('cnn-b');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const connector = await db.connectors(ctx).insert({ name: 'Linear', kind: 'linear', createdByUserId: orgA.userId });
    const found = await db.connectors(ctx).findById(connector.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(connector.id);
  });

  it('findById returns null for a cross-org id', async () => {
    const orgA = await makeOrg('cnn-c');
    const orgB = await makeOrg('cnn-d');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const connector = await db.connectors(ctxA).insert({ name: 'Private', kind: 'custom', createdByUserId: orgA.userId });
    expect(await db.connectors(ctxB).findById(connector.id)).toBeNull();
  });

  it('update with cross-org id returns null', async () => {
    const orgA = await makeOrg('cnn-e');
    const orgB = await makeOrg('cnn-f');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const connector = await db.connectors(ctxA).insert({ name: 'OrigConn', kind: 'github', createdByUserId: orgA.userId });
    const result = await db.connectors(ctxB).update(connector.id, { name: 'Stolen' });
    expect(result).toBeNull();
    expect((await db.connectors(ctxA).findById(connector.id))!.name).toBe('OrigConn');
  });

  it('softDelete with cross-org id returns null', async () => {
    const orgA = await makeOrg('cnn-g');
    const orgB = await makeOrg('cnn-h');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const connector = await db.connectors(ctxA).insert({ name: 'KeepConn', kind: 'notion', createdByUserId: orgA.userId });
    const result = await db.connectors(ctxB).softDelete(connector.id);
    expect(result).toBeNull();
    expect(await db.connectors(ctxA).findById(connector.id)).not.toBeNull();
  });

  it('softDelete with system actor override writes deleted_by_type=system', async () => {
    const orgA = await makeOrg('cnn-i');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const connector = await db.connectors(ctx).insert({ name: 'CompConn', kind: 'custom', createdByUserId: orgA.userId });
    const deleted = await db.connectors(ctx).softDelete(connector.id, { type: 'system', id: null });
    expect(deleted).not.toBeNull();
    expect(deleted!.deletedByType).toBe('system');
    expect(deleted!.deletedById).toBeNull();
  });

  it('list returns only this org\'s connectors', async () => {
    const orgA = await makeOrg('cnn-j');
    const orgB = await makeOrg('cnn-k');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    await db.connectors(ctxA).insert({ name: 'ConnA', kind: 'notion', createdByUserId: orgA.userId });
    await db.connectors(ctxB).insert({ name: 'ConnB', kind: 'linear', createdByUserId: orgB.userId });
    const listA = await db.connectors(ctxA).list();
    expect(listA.every((c) => c.orgId === orgA.orgId)).toBe(true);
    expect(listA.some((c) => c.orgId === orgB.orgId)).toBe(false);
  });

  it('throws DuplicateError on name collision within the same org', async () => {
    const orgA = await makeOrg('cnn-l');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    await db.connectors(ctx).insert({ name: 'DupConn', kind: 'notion', createdByUserId: orgA.userId });
    await expect(
      db.connectors(ctx).insert({ name: 'DupConn', kind: 'linear', createdByUserId: orgA.userId }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });
});
