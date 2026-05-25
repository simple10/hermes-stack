/**
 * Pool resolver — maps an orgId to the Drizzle pool client for that org.
 *
 * Flow:
 *   1. Look up organization.tenantPoolId from the master DB (cached 60s per isolate).
 *   2. Map tenantPoolId → env binding name (e.g. 'default' → POOL_DEFAULT).
 *   3. In single-DB mode, always return env.DB regardless of tenantPoolId.
 *   4. If the binding is missing, throw 503 pool.binding_missing.
 *
 * The 60s cache is per-Worker-isolate, which is the correct scope for
 * Cloudflare Workers.  In self-host / wrangler-dev mode it's effectively
 * per-process.
 */
import { eq } from 'drizzle-orm';
import { organization } from './master.ts';
import { masterClient, poolClient } from './client.ts';
import { HttpError } from '../errors.ts';

// ---------------------------------------------------------------------------
// In-isolate TTL cache: orgId → { tenantPoolId, expiresAt }
// ---------------------------------------------------------------------------

const cache = new Map<string, { tenantPoolId: string; expiresAt: number }>();
const TTL_MS = 60_000; // 60 seconds

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves and returns the Drizzle pool client for the given org.
 *
 * Throws:
 *   404 auth.org_not_found  — org doesn't exist in master DB
 *   503 pool.binding_missing — wrangler.toml / env doesn't have the binding
 */
export async function resolvePoolForOrg(env: Env, orgId: string) {
  const now = Date.now();
  let entry = cache.get(orgId);

  if (!entry || entry.expiresAt < now) {
    const orgRows = await masterClient(env)
      .select({ tenantPoolId: organization.tenantPoolId })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);
    const org = orgRows[0];
    if (!org) {
      throw new HttpError(404, 'auth.org_not_found', `Organization ${orgId} not found`);
    }
    entry = { tenantPoolId: org.tenantPoolId, expiresAt: now + TTL_MS };
    cache.set(orgId, entry);
  }

  const binding = resolveBinding(env, entry.tenantPoolId);
  if (!binding) {
    throw new HttpError(
      503,
      'pool.binding_missing',
      `Pool binding for tenantPoolId '${entry.tenantPoolId}' is not configured. ` +
        'Add the binding to wrangler.toml and redeploy.',
    );
  }
  return poolClient(binding);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Env plus runtime POOL_* bindings (not all are listed in wrangler types). */
type EnvWithPoolBindings = Env & Record<string, D1Database | undefined>;

/**
 * Maps a tenantPoolId to the D1 binding on env.
 *
 * Mapping convention: 'default' → POOL_DEFAULT, 'premium-acme' → POOL_PREMIUM_ACME.
 * Pattern: 'POOL_' + tenantPoolId.toUpperCase().replace(/-/g, '_')
 *
 * In single-DB mode (env.DB_MODE !== 'split'), always return env.DB.
 * The binding_name column in tenant_pools is informational in single mode.
 */
function resolveBinding(env: Env, tenantPoolId: string): D1Database | null {
  if (env.DB_MODE !== 'split') {
    // Single-DB mode: master and pool are the same binding.
    return env.DB ?? null;
  }
  const key = 'POOL_' + tenantPoolId.toUpperCase().replace(/-/g, '_');
  const bindings = env as EnvWithPoolBindings;
  return bindings[key] ?? null;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/** Wipe the in-isolate cache. Call in beforeEach in pool-resolver tests. */
export function _clearPoolCache(): void {
  cache.clear();
}
