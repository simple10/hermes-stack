import { ApiError } from './api';

/** Map API error codes to user-facing messages. Default appends request_id. */
export function messageFor(err: unknown): string {
  if (!(err instanceof ApiError)) {
    if (err instanceof Error) return err.message;
    return 'Something went wrong.';
  }
  const idHint = err.requestId ? ` (request_id: ${err.requestId})` : '';
  switch (err.code) {
    case 'agent.has_active_tasks':
      return `Cannot delete — agent has active tasks.${idHint}`;
    case 'connector.has_active_refs':
      return `Cannot delete — connector still has external refs.${idHint}`;
    case 'auth.invalid':
      return 'Session expired. Please sign in again.';
    case 'auth.role_insufficient':
      return 'You do not have permission to do that.';
    case 'task.invalid_transition':
      return 'That task status change is not allowed.';
    case 'pool.binding_missing':
      return 'Service unavailable. Please try again shortly.';
    case 'idempotency.conflict':
      return 'A request with that idempotency key already exists with a different body.';
    default:
      return `${err.code}${idHint}`;
  }
}
