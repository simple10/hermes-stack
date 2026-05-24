-- migrations/pool/0001_init.sql
-- Pool DB schema: per-tenant task data (agents, connectors, projects, tasks,
-- task_comments, events, external_refs, idempotency_keys).
-- Includes cascade soft-delete triggers and updated_at auto-bump triggers.

-- -----------------------------------------------------------------------
-- agents
-- -----------------------------------------------------------------------
CREATE TABLE agents (
  id                  TEXT PRIMARY KEY,                  -- 'agt_xxx'
  org_id              TEXT NOT NULL,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL,                     -- 'hermes'|'claude'|'openclaw'|...
  description         TEXT,
  last_seen_at        INTEGER,                           -- NULL v1; populated by heartbeat in v1.1
  created_by_user_id  TEXT,                              -- master.user.id (audit only; not FK across DBs)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  deleted_by_type     TEXT,
  deleted_by_id       TEXT
);
CREATE UNIQUE INDEX agents_name_per_org_active
  ON agents(org_id, name) WHERE deleted_at IS NULL;
CREATE INDEX agents_org_kind_active
  ON agents(org_id, kind) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------
-- connectors
-- -----------------------------------------------------------------------
CREATE TABLE connectors (
  id                  TEXT PRIMARY KEY,                  -- 'cnn_xxx'
  org_id              TEXT NOT NULL,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL,                     -- 'notion'|'linear'|'github'|'custom'
  description         TEXT,
  last_seen_at        INTEGER,                           -- bumped by middleware when key used (v1)
  created_by_user_id  TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  deleted_by_type     TEXT,
  deleted_by_id       TEXT
);
CREATE UNIQUE INDEX connectors_name_per_org_active
  ON connectors(org_id, name) WHERE deleted_at IS NULL;
CREATE INDEX connectors_org_kind_active
  ON connectors(org_id, kind) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------
-- projects
-- -----------------------------------------------------------------------
CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,              -- 'prj_xxx'
  org_id              TEXT NOT NULL,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL,
  description         TEXT,
  created_by_user_id  TEXT,                          -- master.user.id (audit)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  deleted_by_type     TEXT,
  deleted_by_id       TEXT
);
CREATE UNIQUE INDEX projects_slug_per_org_active
  ON projects(org_id, slug) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------
-- tasks
-- -----------------------------------------------------------------------
CREATE TABLE tasks (
  id                 TEXT PRIMARY KEY,               -- 't_xxx'
  org_id             TEXT NOT NULL,
  project_id         TEXT NOT NULL,
  agent_id           TEXT,                            -- nullable until assigned
  title              TEXT NOT NULL,
  body               TEXT,
  status             TEXT NOT NULL DEFAULT 'pending', -- see state machine
  priority           INTEGER NOT NULL DEFAULT 0,
  metadata           TEXT,                            -- JSON, free-form
  idempotency_key    TEXT,                            -- caller-supplied dedup key
  created_by_user_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  started_at         INTEGER,
  completed_at       INTEGER,
  deleted_at         INTEGER,
  deleted_by_type    TEXT,
  deleted_by_id      TEXT
);
CREATE INDEX tasks_org_project_active
  ON tasks(org_id, project_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_org_agent_status_active
  ON tasks(org_id, agent_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_org_updated_at
  ON tasks(org_id, updated_at) WHERE deleted_at IS NULL;
-- Layer-2 semantic dedup. Callers MUST namespace their key by their full
-- source identity (e.g. "notion:<workspace_id>:<page_id>" not just
-- "notion:<page_id>") to prevent collisions between different connector
-- instances of the same kind.
CREATE UNIQUE INDEX tasks_idempotency_active
  ON tasks(org_id, idempotency_key) WHERE deleted_at IS NULL AND idempotency_key IS NOT NULL;

-- -----------------------------------------------------------------------
-- task_comments
-- -----------------------------------------------------------------------
CREATE TABLE task_comments (
  id              TEXT PRIMARY KEY,                  -- 'cmt_xxx'
  org_id          TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  author_type     TEXT NOT NULL,                     -- 'user'|'agent'|'connector'|'system'
  author_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  deleted_by_type TEXT,
  deleted_by_id   TEXT
);
CREATE INDEX comments_task_active
  ON task_comments(org_id, task_id, created_at) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------
-- events  (append-only audit log; purged on retention schedule)
-- -----------------------------------------------------------------------
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic per pool DB
  org_id          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,                     -- 'task'|'project'|'agent'|'connector'|'comment'
  resource_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,                     -- see event kind schemas
  actor_type      TEXT,                              -- 'user'|'agent'|'connector'|'system'
  actor_id        TEXT,
  payload         TEXT,                              -- JSON, kind-specific
  created_at      INTEGER NOT NULL
);
CREATE INDEX events_org_id ON events(org_id, id);
CREATE INDEX events_resource ON events(org_id, resource_type, resource_id);

-- -----------------------------------------------------------------------
-- external_refs  (polymorphic link table)
-- -----------------------------------------------------------------------
CREATE TABLE external_refs (
  id              TEXT PRIMARY KEY,                  -- 'xrf_xxx'
  org_id          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,                     -- 'task'|'project'|'agent'|'comment'
  resource_id     TEXT NOT NULL,
  source_kind     TEXT NOT NULL,                     -- 'notion'|'linear'|'hermes'|...
  source_id       TEXT NOT NULL,                     -- 'notion-ws-abc'|'hermes-vm1'|...
  external_id     TEXT NOT NULL,                     -- the foreign system's id
  external_url    TEXT,
  metadata        TEXT,                              -- JSON, source-specific
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  deleted_by_type TEXT,
  deleted_by_id   TEXT
);
CREATE UNIQUE INDEX external_refs_unique_active
  ON external_refs(resource_type, resource_id, source_kind, source_id)
  WHERE deleted_at IS NULL;
CREATE INDEX external_refs_lookup_active
  ON external_refs(org_id, source_kind, external_id) WHERE deleted_at IS NULL;
CREATE INDEX external_refs_reverse_active
  ON external_refs(org_id, resource_type, resource_id) WHERE deleted_at IS NULL;
CREATE INDEX external_refs_source_active
  ON external_refs(org_id, source_kind, source_id) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------
-- idempotency_keys  (request dedup; TTL-purged via expires_at)
-- -----------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  org_id          TEXT NOT NULL,
  route           TEXT NOT NULL,                     -- 'POST /v1/tasks'
  key             TEXT NOT NULL,                     -- value of Idempotency-Key header
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,                  -- created_at + 24h
  PRIMARY KEY (org_id, route, key)
);
CREATE INDEX idempotency_keys_expires ON idempotency_keys(expires_at);

-- -----------------------------------------------------------------------
-- Cascade soft-delete triggers
-- SQLite triggers fire on the UPDATE that sets deleted_at.
-- These are defense-in-depth; app-level helpers also do this in a tx.
-- -----------------------------------------------------------------------

CREATE TRIGGER tasks_soft_delete_cascade
  AFTER UPDATE OF deleted_at ON tasks
  WHEN NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE external_refs SET deleted_at = NEW.deleted_at, deleted_by_type = 'system'
    WHERE resource_type = 'task' AND resource_id = NEW.id AND deleted_at IS NULL;
  UPDATE task_comments SET deleted_at = NEW.deleted_at, deleted_by_type = 'system'
    WHERE task_id = NEW.id AND deleted_at IS NULL;
END;

CREATE TRIGGER projects_soft_delete_cascade
  AFTER UPDATE OF deleted_at ON projects
  WHEN NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE external_refs SET deleted_at = NEW.deleted_at, deleted_by_type = 'system'
    WHERE resource_type = 'project' AND resource_id = NEW.id AND deleted_at IS NULL;
END;

CREATE TRIGGER agents_soft_delete_cascade
  AFTER UPDATE OF deleted_at ON agents
  WHEN NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE external_refs SET deleted_at = NEW.deleted_at, deleted_by_type = 'system'
    WHERE resource_type = 'agent' AND resource_id = NEW.id AND deleted_at IS NULL;
END;

CREATE TRIGGER connectors_soft_delete_cascade
  AFTER UPDATE OF deleted_at ON connectors
  WHEN NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE external_refs SET deleted_at = NEW.deleted_at, deleted_by_type = 'system'
    WHERE resource_type = 'connector' AND resource_id = NEW.id AND deleted_at IS NULL;
END;

-- -----------------------------------------------------------------------
-- updated_at auto-bump triggers
-- Fire when a row is UPDATEd but the caller forgot to bump updated_at.
-- -----------------------------------------------------------------------

CREATE TRIGGER tasks_set_updated_at
  AFTER UPDATE ON tasks
  WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE tasks SET updated_at = unixepoch() * 1000 WHERE id = NEW.id;
END;

CREATE TRIGGER projects_set_updated_at
  AFTER UPDATE ON projects
  WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE projects SET updated_at = unixepoch() * 1000 WHERE id = NEW.id;
END;

CREATE TRIGGER agents_set_updated_at
  AFTER UPDATE ON agents
  WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE agents SET updated_at = unixepoch() * 1000 WHERE id = NEW.id;
END;

CREATE TRIGGER connectors_set_updated_at
  AFTER UPDATE ON connectors
  WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE connectors SET updated_at = unixepoch() * 1000 WHERE id = NEW.id;
END;

CREATE TRIGGER task_comments_set_updated_at
  AFTER UPDATE ON task_comments
  WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE task_comments SET updated_at = unixepoch() * 1000 WHERE id = NEW.id;
END;

CREATE TRIGGER external_refs_set_updated_at
  AFTER UPDATE ON external_refs
  WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE external_refs SET updated_at = unixepoch() * 1000 WHERE id = NEW.id;
END;
