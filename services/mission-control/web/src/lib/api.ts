import type {
  Agent,
  AgentListResponse,
  AgentCreateBody,
  AgentPatchBody,
  AgentCreateResponse,
  AgentRotateKeyResponse,
} from '@api-schemas/agents'
import type {
  Connector,
  ConnectorListResponse,
  ConnectorCreateBody,
  ConnectorPatchBody,
  ConnectorCreateResponse,
  ConnectorRotateKeyResponse,
} from '@api-schemas/connectors'
import type {
  Project,
  ProjectListResponse,
  ProjectCreateBody,
  ProjectPatchBody,
} from '@api-schemas/projects'
import type { TaskListResponse, TaskDetailResponse, TaskListQuery } from '@api-schemas/tasks'
import type { CommentListResponse } from '@api-schemas/comments'
import type { EventListResponse, EventListQuery } from '@api-schemas/events'
import type { ExternalRefListResponse } from '@api-schemas/external-refs'
import type { MeResponse } from '@api-schemas/me'

/**
 * Surfaced HTTP error. Carries the API's structured error code + request id
 * so callers can map to user-facing messages and quote IDs in support cases.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(`${status} ${code}`)
  }
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)))
    else sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const requestId = res.headers.get('x-request-id') ?? undefined
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body?.error?.code ?? 'unknown', body?.error?.details, requestId)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  me: () => request<MeResponse>('/me'),

  agents: {
    list: (q: { cursor?: string; limit?: number } = {}) =>
      request<AgentListResponse>(`/agents${qs(q)}`),
    get: (id: string) => request<{ agent: Agent }>(`/agents/${id}`),
    create: (b: AgentCreateBody) =>
      request<AgentCreateResponse>('/agents', { method: 'POST', body: JSON.stringify(b) }),
    patch: (id: string, b: AgentPatchBody) =>
      request<{ agent: Agent }>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    rotateKey: (id: string) =>
      request<AgentRotateKeyResponse>(`/agents/${id}/rotate-key`, { method: 'POST' }),
    delete: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
  },

  connectors: {
    list: (q: { cursor?: string; limit?: number } = {}) =>
      request<ConnectorListResponse>(`/connectors${qs(q)}`),
    get: (id: string) => request<{ connector: Connector }>(`/connectors/${id}`),
    create: (b: ConnectorCreateBody) =>
      request<ConnectorCreateResponse>('/connectors', { method: 'POST', body: JSON.stringify(b) }),
    patch: (id: string, b: ConnectorPatchBody) =>
      request<{ connector: Connector }>(`/connectors/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(b),
      }),
    rotateKey: (id: string) =>
      request<ConnectorRotateKeyResponse>(`/connectors/${id}/rotate-key`, { method: 'POST' }),
    delete: (id: string) => request<void>(`/connectors/${id}`, { method: 'DELETE' }),
  },

  projects: {
    list: (q: { cursor?: string; limit?: number } = {}) =>
      request<ProjectListResponse>(`/projects${qs(q)}`),
    get: (id: string) => request<{ project: Project }>(`/projects/${id}`),
    create: (b: ProjectCreateBody) =>
      request<{ project: Project }>('/projects', { method: 'POST', body: JSON.stringify(b) }),
    patch: (id: string, b: ProjectPatchBody) =>
      request<{ project: Project }>(`/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(b),
      }),
    delete: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
  },

  tasks: {
    list: (q: TaskListQuery = {}) => request<TaskListResponse>(`/tasks${qs(q as any)}`),
    get: (id: string) => request<TaskDetailResponse>(`/tasks/${id}`),
    comments: (id: string, q: { cursor?: string; limit?: number } = {}) =>
      request<CommentListResponse>(`/tasks/${id}/comments${qs(q)}`),
  },

  events: {
    list: (q: Partial<EventListQuery> = {}) => request<EventListResponse>(`/events${qs(q as any)}`),
  },

  externalRefs: {
    list: (q: { resource_type?: string; resource_id?: string } = {}) =>
      request<ExternalRefListResponse>(`/external_refs${qs(q)}`),
  },
}
