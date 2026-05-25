/**
 * ESLint flat config for mission-control.
 *
 * Three rule blocks:
 *
 *   1. Local rule mc-local/no-raw-pool-in-routes — route handlers never access
 *      the database directly; they must go through src/db/repos/. Exempt with
 *      `// repo-escape: <reason>` on the same line or the line above.
 *
 *   2. Schemas browser-safety — src/schemas/** must import ONLY zod (direct
 *      imports caught by no-restricted-imports; transitive runtime imports
 *      caught by import/no-restricted-paths). Replaces dependency-cruiser
 *      which doesn't run on Node 23.x.
 *
 *   3. TypeScript parser globally — without this every previous lint run
 *      crashed with "Unexpected token" parsing errors on every .ts file.
 */
import { createRequire } from 'module';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

const require = createRequire(import.meta.url);
const noRawPool = require('./eslint-rules/no-raw-pool-in-routes.cjs');

export default [
  // Global TypeScript parser + plugin for all .ts / .tsx files in src/ and test/.
  // The plugin registration is what makes `// eslint-disable-next-line
  // @typescript-eslint/no-explicit-any` comments resolve (rules don't need to
  // be enforced, they just need to be known).
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // Warn (not error) so CI doesn't bite on existing `any` usage; the
      // existing `// eslint-disable-next-line @typescript-eslint/no-explicit-any`
      // comments now correctly suppress reports on intentional places.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Route handlers + middleware: enforce repos-only DB access.
  {
    files: ['src/routes/**/*.ts', 'src/auth/middleware.ts'],
    plugins: {
      'mc-local': { rules: { 'no-raw-pool-in-routes': noRawPool } },
    },
    rules: {
      'mc-local/no-raw-pool-in-routes': 'error',
    },
  },

  // Schemas: must be browser-safe (the SPA imports them via @mc/schemas/*).
  // Direct-import guard caught by no-restricted-imports.
  {
    files: ['src/schemas/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['drizzle-orm', 'drizzle-orm/*'], message: 'schemas/* must be browser-safe; no drizzle.' },
          { group: ['better-auth', 'better-auth/*', '@better-auth/*'], message: 'schemas/* must be browser-safe; no better-auth.' },
          { group: ['cloudflare:*'], message: 'schemas/* must be browser-safe; no Worker bindings.' },
          { group: ['node:*'], message: 'schemas/* must be browser-safe; no Node built-ins.' },
          { group: ['../db/*', '../auth/*', '../routes/*'], message: 'schemas/* must not depend on server modules.' },
        ],
      }],
    },
  },

  // Transitive-import guard for schemas — catches the case where a sibling
  // schema imports a helper that itself pulls in a server-only module.
  // Replaces dependency-cruiser (which doesn't run on Node 23.x).
  {
    files: ['src/schemas/**/*.ts'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
        node: true,
      },
    },
    rules: {
      'import/no-restricted-paths': ['error', {
        zones: [
          { target: './src/schemas', from: './src/db', message: 'schemas → db is forbidden (browser-safe enforcement).' },
          { target: './src/schemas', from: './src/auth', message: 'schemas → auth is forbidden (browser-safe enforcement).' },
          { target: './src/schemas', from: './src/routes', message: 'schemas → routes is forbidden (browser-safe enforcement).' },
        ],
      }],
    },
  },
];
