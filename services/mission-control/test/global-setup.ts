/**
 * test/global-setup.ts
 *
 * Vitest globalSetup — runs in Node context before any test workers start.
 * Reads SQL migrations from the combined dir and provides them to tests via
 * vitest's inject/provide mechanism.
 */
import { readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsPath = path.resolve(__dirname, '../migrations/combined');

declare module 'vitest' {
  export interface ProvidedContext {
    d1Migrations: D1Migration[];
  }
}

export async function setup({ provide }: { provide: (key: string, value: unknown) => void }) {
  const migrations = await readD1Migrations(migrationsPath);
  provide('d1Migrations', migrations);
}
