import { http, HttpResponse } from 'msw';

/**
 * Default MSW handlers — empty-state responses for every list endpoint the UI
 * touches. Per-suite handlers can override via `server.use(http.get(...))`.
 */
export const handlers = [
  http.get('/api/v1/agents', () => HttpResponse.json({ agents: [], next_cursor: null })),
  http.get('/api/v1/connectors', () => HttpResponse.json({ connectors: [], next_cursor: null })),
  http.get('/api/v1/projects', () => HttpResponse.json({ projects: [], next_cursor: null })),
  http.get('/api/v1/tasks', () => HttpResponse.json({ tasks: [], next_cursor: null })),
  http.get('/api/v1/events', () => HttpResponse.json({ events: [], next_cursor: null })),
  http.get('/api/v1/external_refs', () => HttpResponse.json({ external_refs: [], next_cursor: null })),
];
