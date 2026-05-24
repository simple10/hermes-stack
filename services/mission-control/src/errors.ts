/**
 * HTTP error type and response helpers for mission-control.
 *
 * Usage:
 *   throw new HttpError(404, 'task.not_found', 'Task t_abc not found', { task_id: 't_abc' });
 *   return errorResponse(c, err);
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

/** Hono-compatible context shape needed by errorResponse. */
type MinimalCtx = {
  json: (body: unknown, status?: number) => Response;
};

/**
 * Converts any error into a JSON error response following the spec's envelope:
 *   { error: { code, message, details? } }
 *
 * HttpError instances are surfaced as-is.  Unknown errors become 500.
 */
export function errorResponse(c: MinimalCtx, err: unknown): Response {
  if (err instanceof HttpError) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status,
    );
  }
  console.error('unhandled error:', err);
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
}
