import { describe, it, expect } from 'vitest';
import {
  TaskCreateBody,
  TaskPatchBody,
  TaskListQuery,
  Task,
  TaskListResponse,
  TaskDetailResponse,
} from '../../src/schemas/tasks.ts';

describe('tasks schemas', () => {
  it('TaskCreateBody requires project_id + title', () => {
    expect(TaskCreateBody.safeParse({ project_id: 'prj_a', title: 't' }).success).toBe(true);
    expect(TaskCreateBody.safeParse({ project_id: 'prj_a' }).success).toBe(false);
    expect(TaskCreateBody.safeParse({ title: 't' }).success).toBe(false);
  });

  it('TaskCreateBody rejects malformed idempotency_key', () => {
    // No colon prefix → reject.
    expect(TaskCreateBody.safeParse({ project_id: 'prj_a', title: 't', idempotency_key: 'no_colon' }).success).toBe(false);
    // Well-formed → accept.
    expect(
      TaskCreateBody.safeParse({ project_id: 'prj_a', title: 't', idempotency_key: 'notion:ws_a:page_b' }).success,
    ).toBe(true);
  });

  it('TaskPatchBody all-optional; agent_id may be null (unassign)', () => {
    expect(TaskPatchBody.safeParse({}).success).toBe(true);
    expect(TaskPatchBody.safeParse({ agent_id: null }).success).toBe(true);
    expect(TaskPatchBody.safeParse({ status: 'in_progress' }).success).toBe(true);
  });

  it('TaskListQuery accepts both ISO string and ms-epoch for updated_since', () => {
    expect(TaskListQuery.safeParse({ updated_since: '2026-05-24T12:00:00.000Z' }).success).toBe(true);
    expect(TaskListQuery.safeParse({ updated_since: '1716552000000' }).success).toBe(true);
  });

  it('TaskListResponse uses plural-keyed `tasks` (not `data`)', () => {
    expect('tasks' in TaskListResponse.shape).toBe(true);
    expect('data' in TaskListResponse.shape).toBe(false);
  });

  it('TaskDetailResponse embeds task + comments + events (NO external_refs)', () => {
    const keys = Object.keys(TaskDetailResponse.shape);
    expect(keys.sort()).toEqual(['comments', 'events', 'task']);
  });

  it('Task row accepts a representative payload', () => {
    const r = Task.safeParse({
      id: 't_abc', org_id: 'org_x', project_id: 'prj_y', agent_id: null,
      title: 'do x', body: null, status: 'pending', priority: 0,
      metadata: null, idempotency_key: null, created_by_user_id: 'usr_x',
      created_at: '2026-05-24T12:00:00.000Z', updated_at: '2026-05-24T12:00:00.000Z',
      started_at: null, completed_at: null,
      deleted_at: null, deleted_by_type: null, deleted_by_id: null,
    });
    expect(r.success).toBe(true);
  });
});
