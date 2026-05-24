/**
 * Rate-limit middleware stub for Mission Control v1.
 *
 * Real rate limiting requires a Cloudflare Rate Limiter binding configured in
 * wrangler.toml under [env.production.unsafe.bindings] (type = "ratelimit").
 * See https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 *
 * TODO(v1.1): bind RATE_LIMITER and call:
 *   const { success } = await env.RATE_LIMITER.limit({ key: c.req.header('cf-connecting-ip') ?? 'unknown' });
 *   if (!success) return c.json({ error: 'rate_limited' }, 429);
 */
import type { MiddlewareHandler } from 'hono';

export const rateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  // v1 stub: no-op — passes through to the next handler.
  await next();
};
