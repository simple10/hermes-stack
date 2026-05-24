/**
 * Consolidated entry point for all per-repo unit tests.
 *
 * Each per-repo file under test/db/repos/_*.ts exports a registration
 * function that calls describe(). They are NOT named *.test.ts so vitest
 * doesn't pick them up directly. This single file runs them all under one
 * miniflare worker boot, saving ~10 cold-imports of the full Worker bundle
 * (which dominates suite runtime).
 *
 * One beforeAll for the whole file applies migrations once; the per-repo
 * blocks share the migrated D1.
 */
import { beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

import { agentsRepoTests } from './repos/_agents.ts';
import { apiKeysRepoTests } from './repos/_api-keys.ts';
import { commentsRepoTests } from './repos/_comments.ts';
import { connectorsRepoTests } from './repos/_connectors.ts';
import { eventsRepoTests } from './repos/_events.ts';
import { externalRefsRepoTests } from './repos/_external-refs.ts';
import { membersRepoTests } from './repos/_members.ts';
import { orgsRepoTests } from './repos/_orgs.ts';
import { projectsRepoTests } from './repos/_projects.ts';
import { tasksRepoTests } from './repos/_tasks.ts';
import { usersRepoTests } from './repos/_users.ts';

beforeAll(async () => {
  await applyD1Migrations((env.DB as D1Database), inject('d1Migrations') as D1Migration[]);
});

agentsRepoTests();
apiKeysRepoTests();
commentsRepoTests();
connectorsRepoTests();
eventsRepoTests();
externalRefsRepoTests();
membersRepoTests();
orgsRepoTests();
projectsRepoTests();
tasksRepoTests();
usersRepoTests();
