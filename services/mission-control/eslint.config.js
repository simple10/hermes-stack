/**
 * ESLint flat config for mission-control.
 *
 * Enforces that route handlers never access the database directly — they must
 * go through src/db/repos/ instead.  Middleware is also covered because it
 * previously had raw masterClient() calls.
 *
 * Rule: mc-local/no-raw-pool-in-routes (local rule in eslint-rules/)
 * Scope: src/routes/**\/*.ts, src/auth/middleware.ts
 *
 * Exemption: `// repo-escape: <reason>` on the same line or the line above
 * the offending expression.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const noRawPool = require('./eslint-rules/no-raw-pool-in-routes.cjs');

export default [
  {
    files: ['src/routes/**/*.ts', 'src/auth/middleware.ts'],
    plugins: {
      'mc-local': { rules: { 'no-raw-pool-in-routes': noRawPool } },
    },
    rules: {
      'mc-local/no-raw-pool-in-routes': 'error',
    },
  },
];
