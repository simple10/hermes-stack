import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations(env.DB, migrations);
});

describe('migrations', () => {
  it('creates all expected tables in single-DB mode', async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    ).all();
    const names = tables.results.map((r: any) => r.name);
    for (const expected of [
      'user', 'session', 'account', 'verification',
      'organization', 'member', 'invitation', 'apiKey',
      'tenant_pools',
      'agents', 'connectors', 'projects', 'tasks',
      'task_comments', 'events', 'external_refs', 'idempotency_keys',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('creates cascade triggers', async () => {
    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
    ).all();
    const names = triggers.results.map((r: any) => r.name);
    for (const expected of [
      'tasks_soft_delete_cascade',
      'projects_soft_delete_cascade',
      'agents_soft_delete_cascade',
      'connectors_soft_delete_cascade',
      'tasks_set_updated_at',
      'projects_set_updated_at',
      'agents_set_updated_at',
      'connectors_set_updated_at',
      'task_comments_set_updated_at',
      'external_refs_set_updated_at',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('seeds the default tenant pool', async () => {
    const row = await env.DB.prepare(
      "SELECT id, binding_name FROM tenant_pools WHERE id = 'default'"
    ).first();
    expect(row).not.toBeNull();
    expect((row as any).binding_name).toBe('POOL_DEFAULT');
  });
});
