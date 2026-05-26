/**
 * Content-type guard middleware.
 *
 * Rejects state-changing requests (POST, PATCH, PUT, DELETE) that carry
 * a `content-type` of `application/x-www-form-urlencoded` or
 * `multipart/form-data`.  These encodings cannot carry arbitrary JSON and
 * are not part of the API contract.
 *
 * Rule:
 *   - GET / HEAD / OPTIONS → always allowed (not state-changing)
 *   - DELETE with no body  → allowed (content-type is absent or empty)
 *   - Everything else with form-encoded content-type → 415 Unsupported Media Type
 */
import type { MiddlewareHandler } from 'hono'
import { HttpError, errorResponse } from '../errors.ts'

const STATE_CHANGING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

export const requireJsonOnWrites: MiddlewareHandler = async (c, next) => {
  if (!STATE_CHANGING.has(c.req.method)) return next()

  const ct = (c.req.header('content-type') ?? '').toLowerCase()

  // DELETE with no body is fine — content-type will be absent.
  if (c.req.method === 'DELETE' && !ct) return next()

  // Reject form-encoded and multipart bodies on state-changing routes.
  if (ct.startsWith('application/x-www-form-urlencoded') || ct.startsWith('multipart/form-data')) {
    return errorResponse(
      c,
      new HttpError(
        415,
        'unsupported_media_type',
        'Use application/json on state-changing endpoints',
      ),
    )
  }

  return next()
}
