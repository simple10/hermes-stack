"""SQLite-backed link store for the mission-control plugin.

WAL mode. Lives at ``~/.hermes/mission-control/links.db`` in production;
tests pass an explicit path. All functions take ``conn`` as first arg so
callers can hold their own connection if they want to batch writes.

Tables:
  mc_links          — MC task ↔ local kanban task mappings + cursors per link
  mc_comment_links  — bidirectional comment dedup (local↔MC)
  mc_apply_log      — kanban task_events ids written by pull-apply; the
                      push reactor skips these to suppress feedback loops
  mc_cursors        — single-row-per-key cursor store ('events' is the MC
                      events.id cursor; 'kanban_events' is the local
                      task_events.id cursor)
"""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from typing import Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS mc_links (
  local_task_id        TEXT    PRIMARY KEY,
  mc_task_id           TEXT    NOT NULL UNIQUE,
  mc_org_id            TEXT    NOT NULL,
  mc_project_id        TEXT    NOT NULL,
  mc_agent_id          TEXT,
  source               TEXT    NOT NULL,
  local_status         TEXT    NOT NULL,
  last_terminal_state  TEXT,
  last_pulled_at       INTEGER NOT NULL DEFAULT 0,
  last_pushed_at       INTEGER NOT NULL DEFAULT 0,
  last_pull_applied_at INTEGER NOT NULL DEFAULT 0,
  push_dirty           INTEGER NOT NULL DEFAULT 0,
  push_failed_until    INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mc_links_dirty_idx
  ON mc_links(push_dirty) WHERE push_dirty = 1;
CREATE INDEX IF NOT EXISTS mc_links_active_idx
  ON mc_links(local_status) WHERE local_status NOT IN ('done', 'archived');

CREATE TABLE IF NOT EXISTS mc_comment_links (
  local_comment_id  INTEGER PRIMARY KEY,
  mc_comment_id     TEXT    NOT NULL UNIQUE,
  local_task_id     TEXT    NOT NULL,
  source            TEXT    NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mc_apply_log (
  event_id    INTEGER PRIMARY KEY,
  link_id     TEXT    NOT NULL,
  applied_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mc_apply_log_applied ON mc_apply_log(applied_at);

CREATE TABLE IF NOT EXISTS mc_cursors (
  k           TEXT    PRIMARY KEY,
  cursor      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
"""


@dataclass
class Link:
    local_task_id: str
    mc_task_id: str
    mc_org_id: str
    mc_project_id: str
    mc_agent_id: Optional[str]
    source: str
    local_status: str
    last_terminal_state: Optional[str]
    last_pulled_at: int
    last_pushed_at: int
    last_pull_applied_at: int
    push_dirty: int
    push_failed_until: int
    created_at: int


def connect(path: str) -> sqlite3.Connection:
    """Open (or create) the links.db at ``path`` in WAL mode and apply schema."""
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    return conn


def _now_ms() -> int:
    return int(time.time() * 1000)


def _row_to_link(r) -> Link:
    return Link(
        local_task_id=r["local_task_id"],
        mc_task_id=r["mc_task_id"],
        mc_org_id=r["mc_org_id"],
        mc_project_id=r["mc_project_id"],
        mc_agent_id=r["mc_agent_id"],
        source=r["source"],
        local_status=r["local_status"],
        last_terminal_state=r["last_terminal_state"],
        last_pulled_at=r["last_pulled_at"],
        last_pushed_at=r["last_pushed_at"],
        last_pull_applied_at=r["last_pull_applied_at"],
        push_dirty=r["push_dirty"],
        push_failed_until=r["push_failed_until"],
        created_at=r["created_at"],
    )


# ── mc_links ─────────────────────────────────────────────────────────


def insert_link(
    conn: sqlite3.Connection,
    *,
    local_task_id: str,
    mc_task_id: str,
    mc_org_id: str,
    mc_project_id: str,
    mc_agent_id: Optional[str],
    source: str,
    local_status: str,
    last_pulled_at: int,
    last_pushed_at: int = 0,
) -> None:
    now = _now_ms()
    conn.execute(
        """INSERT INTO mc_links
           (local_task_id, mc_task_id, mc_org_id, mc_project_id, mc_agent_id,
            source, local_status, last_pulled_at, last_pushed_at,
            last_pull_applied_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            local_task_id, mc_task_id, mc_org_id, mc_project_id, mc_agent_id,
            source, local_status, last_pulled_at, last_pushed_at, now, now,
        ),
    )


def get_link(conn: sqlite3.Connection, local_task_id: str) -> Optional[Link]:
    r = conn.execute(
        "SELECT * FROM mc_links WHERE local_task_id = ?",
        (local_task_id,),
    ).fetchone()
    return _row_to_link(r) if r else None


def get_link_by_mc(conn: sqlite3.Connection, mc_task_id: str) -> Optional[Link]:
    r = conn.execute(
        "SELECT * FROM mc_links WHERE mc_task_id = ?",
        (mc_task_id,),
    ).fetchone()
    return _row_to_link(r) if r else None


def list_active_links(conn: sqlite3.Connection) -> list[Link]:
    """Links whose local task is not in a terminal state."""
    rows = conn.execute(
        "SELECT * FROM mc_links WHERE local_status NOT IN ('done', 'archived')",
    ).fetchall()
    return [_row_to_link(r) for r in rows]


def list_dirty_links(conn: sqlite3.Connection) -> list[Link]:
    rows = conn.execute(
        "SELECT * FROM mc_links WHERE push_dirty = 1",
    ).fetchall()
    return [_row_to_link(r) for r in rows]


def delete_link(conn: sqlite3.Connection, local_task_id: str) -> None:
    conn.execute("DELETE FROM mc_links WHERE local_task_id = ?", (local_task_id,))


def update_link_state(
    conn: sqlite3.Connection,
    local_task_id: str,
    *,
    local_status: Optional[str] = None,
    last_pulled_at: Optional[int] = None,
    last_pushed_at: Optional[int] = None,
    last_terminal_state: Optional[str] = None,
    push_dirty: Optional[int] = None,
    push_failed_until: Optional[int] = None,
) -> None:
    """Partial update — only the kwargs that are not None are written.

    When ``last_pulled_at`` is set, ``last_pull_applied_at`` is bumped to now
    (the wall-clock the apply landed locally).
    """
    sets: list[str] = []
    args: list[object] = []
    if local_status is not None:
        sets.append("local_status = ?"); args.append(local_status)
    if last_pulled_at is not None:
        sets.append("last_pulled_at = ?"); args.append(last_pulled_at)
        sets.append("last_pull_applied_at = ?"); args.append(_now_ms())
    if last_pushed_at is not None:
        sets.append("last_pushed_at = ?"); args.append(last_pushed_at)
    if last_terminal_state is not None:
        sets.append("last_terminal_state = ?"); args.append(last_terminal_state)
    if push_dirty is not None:
        sets.append("push_dirty = ?"); args.append(push_dirty)
    if push_failed_until is not None:
        sets.append("push_failed_until = ?"); args.append(push_failed_until)
    if not sets:
        return
    args.append(local_task_id)
    conn.execute(
        f"UPDATE mc_links SET {', '.join(sets)} WHERE local_task_id = ?",
        args,
    )


# ── mc_comment_links ────────────────────────────────────────────────


def insert_comment_link(
    conn: sqlite3.Connection,
    *,
    local_comment_id: int,
    mc_comment_id: str,
    local_task_id: str,
    source: str,
) -> None:
    conn.execute(
        """INSERT OR IGNORE INTO mc_comment_links
           (local_comment_id, mc_comment_id, local_task_id, source, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (local_comment_id, mc_comment_id, local_task_id, source, _now_ms()),
    )


def comment_has_local(conn: sqlite3.Connection, local_comment_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM mc_comment_links WHERE local_comment_id = ?",
        (local_comment_id,),
    ).fetchone() is not None


def comment_has_mc(conn: sqlite3.Connection, mc_comment_id: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM mc_comment_links WHERE mc_comment_id = ?",
        (mc_comment_id,),
    ).fetchone() is not None


# ── mc_apply_log ────────────────────────────────────────────────────


def record_apply(
    conn: sqlite3.Connection,
    *,
    event_id: int,
    link_id: str,
    applied_at: Optional[int] = None,
) -> None:
    conn.execute(
        """INSERT OR REPLACE INTO mc_apply_log
           (event_id, link_id, applied_at) VALUES (?, ?, ?)""",
        (event_id, link_id, applied_at if applied_at is not None else _now_ms()),
    )


def is_in_apply_log(conn: sqlite3.Connection, event_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM mc_apply_log WHERE event_id = ?",
        (event_id,),
    ).fetchone() is not None


def purge_apply_log(conn: sqlite3.Connection, older_than_ms: int) -> int:
    """Delete apply-log entries older than ``older_than_ms`` (from now).

    Returns the number of rows deleted.
    """
    cutoff = _now_ms() - older_than_ms
    cur = conn.execute(
        "DELETE FROM mc_apply_log WHERE applied_at < ?",
        (cutoff,),
    )
    return cur.rowcount


# ── mc_cursors ──────────────────────────────────────────────────────


def get_cursor(conn: sqlite3.Connection, k: str) -> int:
    r = conn.execute(
        "SELECT cursor FROM mc_cursors WHERE k = ?",
        (k,),
    ).fetchone()
    return int(r["cursor"]) if r else 0


def set_cursor(conn: sqlite3.Connection, k: str, cursor: int) -> None:
    conn.execute(
        """INSERT INTO mc_cursors (k, cursor, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(k) DO UPDATE SET cursor = excluded.cursor,
                                         updated_at = excluded.updated_at""",
        (k, cursor, _now_ms()),
    )
