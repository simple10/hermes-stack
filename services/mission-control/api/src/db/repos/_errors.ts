/**
 * Typed domain errors thrown by repo methods.
 *
 * Repos stay HTTP-agnostic.  Route handlers catch these and map them to
 * HttpError / errorResponse.  Never import HttpError here.
 *
 * Pattern in handlers:
 *   import { DuplicateError, ForbiddenError } from '../db/repos/_errors.ts';
 *   try {
 *     const row = await db.tasks(ctx).insert(values);
 *   } catch (e) {
 *     if (e instanceof DuplicateError) {
 *       return errorResponse(c, new HttpError(409, `${e.resource}.duplicate`, e.message, e.details));
 *     }
 *     if (e instanceof ForbiddenError) {
 *       return errorResponse(c, new HttpError(403, e.code, e.message, e.details));
 *     }
 *     throw e;
 *   }
 */

/**
 * Thrown when a UNIQUE constraint violation is caught by a repo insert or update.
 * Handlers map this to HTTP 409.
 *
 * @param resource   Resource name (e.g. 'project', 'agent').
 * @param details    Extra details to include in the error response (e.g. existing_project_id).
 * @param code       Optional specific error code.  Defaults to `${resource}.duplicate`.
 *                   Use when the resource has named variants (e.g. 'project.duplicate_slug').
 */
export class DuplicateError extends Error {
  constructor(
    public readonly resource: string,
    public readonly details: Record<string, unknown> = {},
    public readonly code?: string,
  ) {
    super(`${resource} already exists`)
    this.name = 'DuplicateError'
  }
}

/**
 * Thrown when a machine principal attempts an operation outside its own
 * scope (e.g., an agent posting an external_ref with another agent's
 * source_id).  Handlers map this to HTTP 403.
 */
export class ForbiddenError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ForbiddenError'
  }
}
