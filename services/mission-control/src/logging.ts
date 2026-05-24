/**
 * Logging middleware for Mission Control.
 *
 * Emits a single JSON line per request to console.log (captured by
 * Cloudflare Workers log drain / local wrangler dev output).
 *
 * Body capture is intentionally disabled to avoid leaking credentials on
 * sensitive paths (auth endpoints, bootstrap).
 */
import type { MiddlewareHandler } from 'hono';

// Paths whose request/response bodies must never be logged.
const SENSITIVE_PATHS = ['/v1/auth/', '/v1/bootstrap'];

function isSensitive(path: string): boolean {
  return SENSITIVE_PATHS.some((prefix) => path.startsWith(prefix));
}

export const loggingMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now();

  // Prefer Cloudflare's stable request id; fall back to caller-supplied or generated.
  const requestId =
    c.req.header('cf-request-id') ??
    c.req.header('x-request-id') ??
    crypto.randomUUID();

  // Propagate to response so callers can correlate logs.
  c.header('X-Request-Id', requestId);

  await next();

  const ms = Date.now() - start;
  const path = new URL(c.req.url).pathname;

  // Auth context is set by authMiddleware on authenticated routes.
  const auth = c.get('auth' as any) as
    | { orgId?: string; principal?: { type: string; id: string } }
    | undefined;

  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    request_id: requestId,
    method: c.req.method,
    path,
    status: c.res.status,
    ms,
  };

  // Only include identity fields on non-sensitive paths.
  if (!isSensitive(path)) {
    line.org_id = auth?.orgId;
    line.principal = auth?.principal
      ? `${auth.principal.type}:${auth.principal.id}`
      : undefined;
  }

  console.log(JSON.stringify(line));
};
