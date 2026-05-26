/**
 * Pool DB schema — per-tenant task data.
 *
 * One pool DB hosts many orgs (in v1, all orgs share POOL_DEFAULT).
 * Every table has an `org_id` column that is REQUIRED in every query —
 * enforced via the withOrg() helper (src/db/client.ts) and a CI lint rule.
 *
 * Column layout follows the spec's "Pool DB" section exactly.
 */
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(), // 'agt_xxx'
    orgId: text('org_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // 'hermes'|'claude'|'openclaw'|…
    description: text('description'),
    lastSeenAt: integer('last_seen_at'), // NULL in v1; populated by heartbeat v1.1
    createdByUserId: text('created_by_user_id'), // master.user.id (audit only; not FK across DBs)
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    deletedByType: text('deleted_by_type'),
    deletedById: text('deleted_by_id'),
  },
  (t) => [
    uniqueIndex('agents_name_per_org_active')
      .on(t.orgId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    index('agents_org_kind_active')
      .on(t.orgId, t.kind)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
)

// ---------------------------------------------------------------------------
// connectors
// ---------------------------------------------------------------------------

export const connectors = sqliteTable(
  'connectors',
  {
    id: text('id').primaryKey(), // 'cnn_xxx'
    orgId: text('org_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // 'notion'|'linear'|'github'|'custom'
    description: text('description'),
    lastSeenAt: integer('last_seen_at'), // bumped by middleware when key used (v1)
    createdByUserId: text('created_by_user_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    deletedByType: text('deleted_by_type'),
    deletedById: text('deleted_by_id'),
  },
  (t) => [
    uniqueIndex('connectors_name_per_org_active')
      .on(t.orgId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    index('connectors_org_kind_active')
      .on(t.orgId, t.kind)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
)

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(), // 'prj_xxx'
    orgId: text('org_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    createdByUserId: text('created_by_user_id'), // master.user.id (audit)
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    deletedByType: text('deleted_by_type'),
    deletedById: text('deleted_by_id'),
  },
  (t) => [
    uniqueIndex('projects_slug_per_org_active')
      .on(t.orgId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
)

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(), // 't_xxx'
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    agentId: text('agent_id'), // nullable until assigned
    title: text('title').notNull(),
    body: text('body'),
    status: text('status').notNull().default('pending'), // see state machine
    priority: integer('priority').notNull().default(0),
    metadata: text('metadata'), // JSON, free-form
    idempotencyKey: text('idempotency_key'), // caller-supplied dedup key
    createdByUserId: text('created_by_user_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    deletedAt: integer('deleted_at'),
    deletedByType: text('deleted_by_type'),
    deletedById: text('deleted_by_id'),
  },
  (t) => [
    index('tasks_org_project_active')
      .on(t.orgId, t.projectId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('tasks_org_agent_status_active')
      .on(t.orgId, t.agentId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('tasks_org_updated_at')
      .on(t.orgId, t.updatedAt)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('tasks_idempotency_active')
      .on(t.orgId, t.idempotencyKey)
      .where(sql`${t.deletedAt} IS NULL AND ${t.idempotencyKey} IS NOT NULL`),
  ],
)

// ---------------------------------------------------------------------------
// task_comments
// ---------------------------------------------------------------------------

export const taskComments = sqliteTable(
  'task_comments',
  {
    id: text('id').primaryKey(), // 'cmt_xxx'
    orgId: text('org_id').notNull(),
    taskId: text('task_id').notNull(),
    authorType: text('author_type').notNull(), // 'user'|'agent'|'connector'|'system'
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    deletedByType: text('deleted_by_type'),
    deletedById: text('deleted_by_id'),
  },
  (t) => [
    index('comments_task_active')
      .on(t.orgId, t.taskId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
)

// ---------------------------------------------------------------------------
// events  (append-only audit log)
// ---------------------------------------------------------------------------

export const events = sqliteTable(
  'events',
  {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }), // monotonic per pool DB
    orgId: text('org_id').notNull(),
    resourceType: text('resource_type').notNull(), // 'task'|'project'|'agent'|'connector'|'comment'
    resourceId: text('resource_id').notNull(),
    kind: text('kind').notNull(), // see kinds + payload schemas
    actorType: text('actor_type'), // 'user'|'agent'|'connector'|'system'
    actorId: text('actor_id'),
    payload: text('payload'), // JSON, kind-specific
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('events_org_id').on(t.orgId, t.id),
    index('events_resource').on(t.orgId, t.resourceType, t.resourceId),
  ],
)

// ---------------------------------------------------------------------------
// external_refs  (polymorphic link table)
// ---------------------------------------------------------------------------

export const externalRefs = sqliteTable(
  'external_refs',
  {
    id: text('id').primaryKey(), // 'xrf_xxx'
    orgId: text('org_id').notNull(),
    resourceType: text('resource_type').notNull(), // 'task'|'project'|'agent'|'comment'
    resourceId: text('resource_id').notNull(),
    sourceKind: text('source_kind').notNull(), // 'notion'|'linear'|'hermes'|…
    sourceId: text('source_id').notNull(), // 'notion-ws-abc'|'hermes-vm1'|…
    externalId: text('external_id').notNull(), // the foreign system's id
    externalUrl: text('external_url'),
    metadata: text('metadata'), // JSON, source-specific
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    deletedByType: text('deleted_by_type'),
    deletedById: text('deleted_by_id'),
  },
  (t) => [
    uniqueIndex('external_refs_unique_active')
      .on(t.resourceType, t.resourceId, t.sourceKind, t.sourceId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('external_refs_lookup_active')
      .on(t.orgId, t.sourceKind, t.externalId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('external_refs_reverse_active')
      .on(t.orgId, t.resourceType, t.resourceId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('external_refs_source_active')
      .on(t.orgId, t.sourceKind, t.sourceId)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
)

// ---------------------------------------------------------------------------
// idempotency_keys  (request dedup; TTL-purged)
// ---------------------------------------------------------------------------

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    orgId: text('org_id').notNull(),
    route: text('route').notNull(), // 'POST /v1/tasks'
    key: text('key').notNull(), // value of Idempotency-Key header
    responseStatus: integer('response_status').notNull(),
    responseBody: text('response_body').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(), // created_at + 24h
  },
  (t) => [index('idempotency_keys_expires').on(t.expiresAt)],
)
