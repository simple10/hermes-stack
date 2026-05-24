# Hermes ↔ MissionControl Plugin Implementation Plan — Part 2

> **For agentic workers:** Continues `docs/plans/2026-05-23-mission-control-plugin.md` (Tasks 1-6). Same TDD pattern; use superpowers:subagent-driven-development or superpowers:executing-plans.

**Spec:** `docs/specs/2026-05-23-mission-control-plugin-design.md` (rev 3).

---

## Phase 3 — Storage layer

### Task 7: `links_db.py` — schema + helpers

**Files:**
- Create: `services/hermes/plugins/mission-control/links_db.py`
- Test: `services/hermes/plugins/mission-control/tests/test_links_db.py`

- [ ] **Step 1: Write failing tests**

Write `tests/test_links_db.py`:

```python
from __future__ import annotations

import time
from pathlib import Path

import pytest

from mission_control import links_db as ldb


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "links.db"
    conn = ldb.connect(str(path))
    return conn


def test_schema_creates_all_tables(db):
    tables = {row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert {"mc_links", "mc_comment_links", "mc_apply_log", "mc_pull_cursor"} <= tables


def test_insert_and_get_link(db):
    ldb.insert_link(db, local_task_id="t_abc", mc_task_id="t_xyz",
                   mc_org_id="org_1", mc_project_id="prj_1",
                   mc_agent_id="agt_1", source="pulled",
                   local_status="ready", last_pulled_at=1000)
    link = ldb.get_link(db, "t_abc")
    assert link is not None
    assert link.mc_task_id == "t_xyz"
    assert link.local_status == "ready"
    assert link.last_pulled_at == 1000


def test_get_link_by_mc_task_id(db):
    ldb.insert_link(db, local_task_id="t_abc", mc_task_id="t_xyz",
                   mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                   source="pulled", local_status="ready", last_pulled_at=0)
    link = ldb.get_link_by_mc(db, "t_xyz")
    assert link is not None and link.local_task_id == "t_abc"


def test_list_active_links_filters_terminal_states(db):
    for i, s in enumerate(("ready", "running", "blocked", "done", "archived")):
        ldb.insert_link(db, local_task_id=f"t_{i}", mc_task_id=f"t_mc_{i}",
                       mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                       source="pulled", local_status=s, last_pulled_at=0)
    active = ldb.list_active_links(db)
    statuses = {l.local_status for l in active}
    assert "done" not in statuses
    assert "archived" not in statuses
    assert {"ready", "running", "blocked"} <= statuses


def test_pull_cursor_roundtrip(db):
    assert ldb.get_pull_cursor(db, "tasks") == 0
    ldb.set_pull_cursor(db, "tasks", 12345)
    assert ldb.get_pull_cursor(db, "tasks") == 12345
    ldb.set_pull_cursor(db, "tasks", 12346)
    assert ldb.get_pull_cursor(db, "tasks") == 12346


def test_comment_link_dedup(db):
    ldb.insert_comment_link(db, local_comment_id=1, mc_comment_id="cmt_1",
                           local_task_id="t_abc", source="pulled")
    assert ldb.comment_has_local(db, 1) is True
    assert ldb.comment_has_mc(db, "cmt_1") is True
    assert ldb.comment_has_local(db, 999) is False
    assert ldb.comment_has_mc(db, "cmt_999") is False


def test_apply_log_record_and_query(db):
    ldb.record_apply(db, event_id=42, link_id="t_abc")
    ldb.record_apply(db, event_id=43, link_id="t_abc")
    assert ldb.is_in_apply_log(db, 42) is True
    assert ldb.is_in_apply_log(db, 43) is True
    assert ldb.is_in_apply_log(db, 44) is False


def test_apply_log_purge_old_entries(db):
    old_ts = int(time.time() * 1000) - 25 * 3600 * 1000  # 25h ago
    fresh_ts = int(time.time() * 1000) - 1000  # 1s ago
    ldb.record_apply(db, event_id=1, link_id="t_a", applied_at=old_ts)
    ldb.record_apply(db, event_id=2, link_id="t_a", applied_at=fresh_ts)
    ldb.purge_apply_log(db, older_than_ms=24 * 3600 * 1000)
    assert ldb.is_in_apply_log(db, 1) is False
    assert ldb.is_in_apply_log(db, 2) is True


def test_update_link_local_status_and_terminal(db):
    ldb.insert_link(db, local_task_id="t_abc", mc_task_id="t_xyz",
                   mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                   source="pulled", local_status="ready", last_pulled_at=0)
    ldb.update_link_state(db, "t_abc", local_status="done",
                         last_pulled_at=1000, last_terminal_state="completed")
    link = ldb.get_link(db, "t_abc")
    assert link.local_status == "done"
    assert link.last_terminal_state == "completed"


def test_orphan_link_delete(db):
    ldb.insert_link(db, local_task_id="t_abc", mc_task_id="t_xyz",
                   mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                   source="pulled", local_status="ready", last_pulled_at=0)
    ldb.delete_link(db, "t_abc")
    assert ldb.get_link(db, "t_abc") is None


def test_set_link_comment_cursor(db):
    ldb.insert_link(db, local_task_id="t_abc", mc_task_id="t_xyz",
                   mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                   source="pulled", local_status="ready", last_pulled_at=0)
    ldb.set_link_comment_cursor(db, "t_abc", "cursor_xyz")
    link = ldb.get_link(db, "t_abc")
    assert link.last_comment_cursor == "cursor_xyz"
```

- [ ] **Step 2: Run — verify failure**

```bash
cd services/hermes/plugins/mission-control && pytest tests/test_links_db.py -v
```

Expected: ModuleNotFoundError for `mission_control.links_db`.

- [ ] **Step 3: Implement**

Write `services/hermes/plugins/mission-control/links_db.py`:

```python
"""SQLite-backed link store for the mission-control plugin.

WAL mode. Lives at ``~/.hermes/mission-control/links.db`` in production;
tests pass an explicit path. All functions take ``conn`` as first arg
so callers can hold their own connection if they want to batch writes.
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
  last_comment_cursor  TEXT    NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS mc_pull_cursor (
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
    last_comment_cursor: str
    push_dirty: int
    push_failed_until: int
    created_at: int


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    return conn


def _now_ms() -> int:
    return int(time.time() * 1000)


def insert_link(conn, *, local_task_id, mc_task_id, mc_org_id, mc_project_id,
                mc_agent_id, source, local_status, last_pulled_at,
                last_pushed_at=0):
    conn.execute(
        """INSERT INTO mc_links
           (local_task_id, mc_task_id, mc_org_id, mc_project_id, mc_agent_id,
            source, local_status, last_pulled_at, last_pushed_at,
            last_pull_applied_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (local_task_id, mc_task_id, mc_org_id, mc_project_id, mc_agent_id,
         source, local_status, last_pulled_at, last_pushed_at, _now_ms(), _now_ms()),
    )


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
        last_comment_cursor=r["last_comment_cursor"],
        push_dirty=r["push_dirty"],
        push_failed_until=r["push_failed_until"],
        created_at=r["created_at"],
    )


def get_link(conn, local_task_id: str) -> Optional[Link]:
    r = conn.execute("SELECT * FROM mc_links WHERE local_task_id = ?",
                     (local_task_id,)).fetchone()
    return _row_to_link(r) if r else None


def get_link_by_mc(conn, mc_task_id: str) -> Optional[Link]:
    r = conn.execute("SELECT * FROM mc_links WHERE mc_task_id = ?",
                     (mc_task_id,)).fetchone()
    return _row_to_link(r) if r else None


def list_active_links(conn) -> list[Link]:
    rows = conn.execute(
        "SELECT * FROM mc_links WHERE local_status NOT IN ('done', 'archived')",
    ).fetchall()
    return [_row_to_link(r) for r in rows]


def list_dirty_links(conn) -> list[Link]:
    rows = conn.execute("SELECT * FROM mc_links WHERE push_dirty = 1").fetchall()
    return [_row_to_link(r) for r in rows]


def delete_link(conn, local_task_id: str) -> None:
    conn.execute("DELETE FROM mc_links WHERE local_task_id = ?", (local_task_id,))


def update_link_state(conn, local_task_id: str, *,
                      local_status: Optional[str] = None,
                      last_pulled_at: Optional[int] = None,
                      last_pushed_at: Optional[int] = None,
                      last_terminal_state: Optional[str] = None,
                      push_dirty: Optional[int] = None,
                      push_failed_until: Optional[int] = None) -> None:
    sets, args = [], []
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
    conn.execute(f"UPDATE mc_links SET {', '.join(sets)} WHERE local_task_id = ?", args)


def set_link_comment_cursor(conn, local_task_id: str, cursor: str) -> None:
    conn.execute("UPDATE mc_links SET last_comment_cursor = ? WHERE local_task_id = ?",
                 (cursor, local_task_id))


def insert_comment_link(conn, *, local_comment_id, mc_comment_id, local_task_id, source):
    conn.execute(
        """INSERT OR IGNORE INTO mc_comment_links
           (local_comment_id, mc_comment_id, local_task_id, source, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (local_comment_id, mc_comment_id, local_task_id, source, _now_ms()),
    )


def comment_has_local(conn, local_comment_id: int) -> bool:
    return conn.execute("SELECT 1 FROM mc_comment_links WHERE local_comment_id = ?",
                        (local_comment_id,)).fetchone() is not None


def comment_has_mc(conn, mc_comment_id: str) -> bool:
    return conn.execute("SELECT 1 FROM mc_comment_links WHERE mc_comment_id = ?",
                        (mc_comment_id,)).fetchone() is not None


def record_apply(conn, *, event_id: int, link_id: str, applied_at: Optional[int] = None) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO mc_apply_log (event_id, link_id, applied_at) VALUES (?, ?, ?)",
        (event_id, link_id, applied_at if applied_at is not None else _now_ms()),
    )


def is_in_apply_log(conn, event_id: int) -> bool:
    return conn.execute("SELECT 1 FROM mc_apply_log WHERE event_id = ?",
                        (event_id,)).fetchone() is not None


def purge_apply_log(conn, older_than_ms: int) -> int:
    cutoff = _now_ms() - older_than_ms
    cur = conn.execute("DELETE FROM mc_apply_log WHERE applied_at < ?", (cutoff,))
    return cur.rowcount


def get_pull_cursor(conn, k: str) -> int:
    r = conn.execute("SELECT cursor FROM mc_pull_cursor WHERE k = ?", (k,)).fetchone()
    return int(r["cursor"]) if r else 0


def set_pull_cursor(conn, k: str, cursor: int) -> None:
    conn.execute(
        """INSERT INTO mc_pull_cursor (k, cursor, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(k) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at""",
        (k, cursor, _now_ms()),
    )
```

- [ ] **Step 4: Run — verify pass**

```bash
cd services/hermes/plugins/mission-control && pytest tests/test_links_db.py -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/hermes/plugins/mission-control/links_db.py services/hermes/plugins/mission-control/tests/test_links_db.py
git commit -m "feat(mc plugin): links_db (plugin-owned SQLite link store)

Schema: mc_links + mc_comment_links + mc_apply_log + mc_pull_cursor.
All four tables in WAL mode. Helpers cover the read/write patterns
used by pull, push, apply, and registrar."
```

---

## Phase 4 — HTTP client

### Task 8: `config.py` — env + auth.json (with mtime cache)

**Files:**
- Create: `services/hermes/plugins/mission-control/config.py`
- Test: `services/hermes/plugins/mission-control/tests/test_config.py`

- [ ] **Step 1: Write failing tests**

```python
import json
import os
from pathlib import Path
import pytest

from mission_control import config as cfg


def test_load_env_defaults(monkeypatch):
    for k in ("HERMES_MC_URL", "HERMES_MC_AGENT_NAME", "HERMES_MC_BOARD",
              "HERMES_MC_POLL_INTERVAL", "HERMES_MC_BOOTSTRAP_SINCE",
              "HERMES_MC_DEFAULT_PROJECT_SLUG", "HERMES_MC_DEBUG",
              "HERMES_MC_USER_PAT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    e = cfg.load_env()
    assert e.url == "https://mc.example.com"
    assert e.board == "mc"
    assert e.poll_interval_s == 10
    assert e.bootstrap_since == "7d"
    assert e.debug is False


def test_load_env_overrides(monkeypatch):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("HERMES_MC_BOARD", "team-a")
    monkeypatch.setenv("HERMES_MC_POLL_INTERVAL", "5")
    monkeypatch.setenv("HERMES_MC_DEBUG", "true")
    e = cfg.load_env()
    assert e.board == "team-a"
    assert e.poll_interval_s == 5
    assert e.debug is True


def test_load_env_clamps_min_poll(monkeypatch):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("HERMES_MC_POLL_INTERVAL", "0")
    e = cfg.load_env()
    assert e.poll_interval_s == 2  # minimum


def test_load_env_missing_url_returns_inert(monkeypatch):
    monkeypatch.delenv("HERMES_MC_URL", raising=False)
    assert cfg.load_env() is None


def test_load_auth_returns_none_when_file_missing(tmp_path):
    assert cfg.load_auth(tmp_path / "auth.json") is None


def test_load_auth_returns_none_when_no_mc_block(tmp_path):
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"providers": {"other": {}}}))
    assert cfg.load_auth(p) is None


def test_load_auth_returns_block(tmp_path):
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"providers": {"mission_control": {
        "url": "https://mc.example.com",
        "org_id": "org_1",
        "agent_id": "agt_1",
        "agent_key": "mcagt_xxx",
        "connector_id": "cnn_1",
        "connector_key": "mccnn_xxx",
        "registered_at": 12345,
    }}}))
    a = cfg.load_auth(p)
    assert a is not None
    assert a.agent_key == "mcagt_xxx"
    assert a.connector_id == "cnn_1"


def test_load_auth_caches_by_mtime(tmp_path):
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"providers": {"mission_control": {
        "url": "https://mc.example.com", "org_id": "org_1", "agent_id": "agt_1",
        "agent_key": "mcagt_a", "connector_id": "cnn_1",
        "connector_key": "mccnn_a", "registered_at": 1,
    }}}))
    cfg._reset_cache_for_tests()
    a1 = cfg.load_auth(p)
    a2 = cfg.load_auth(p)
    assert a1 is a2  # cached identity

    # Mutate + bump mtime → cache invalidates
    import os, time
    new_mtime = a1._mtime + 1.0
    os.utime(p, (new_mtime, new_mtime))
    p.write_text(json.dumps({"providers": {"mission_control": {
        "url": "https://mc.example.com", "org_id": "org_1", "agent_id": "agt_1",
        "agent_key": "mcagt_b", "connector_id": "cnn_1",
        "connector_key": "mccnn_b", "registered_at": 2,
    }}}))
    os.utime(p, (new_mtime, new_mtime))
    a3 = cfg.load_auth(p)
    assert a3.agent_key == "mcagt_b"


def test_save_auth_roundtrip(tmp_path):
    p = tmp_path / "auth.json"
    cfg.save_auth(p, agent_id="agt_1", agent_key="mcagt_x", org_id="org_1",
                  connector_id="cnn_1", connector_key="mccnn_x",
                  url="https://mc.example.com")
    a = cfg.load_auth(p)
    assert a.agent_key == "mcagt_x"


def test_save_auth_preserves_other_providers(tmp_path):
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"providers": {"spotify": {"token": "abc"}}}))
    cfg.save_auth(p, agent_id="agt_1", agent_key="mcagt_x", org_id="org_1",
                  connector_id="cnn_1", connector_key="mccnn_x",
                  url="https://mc.example.com")
    data = json.loads(p.read_text())
    assert data["providers"]["spotify"]["token"] == "abc"
    assert data["providers"]["mission_control"]["agent_key"] == "mcagt_x"
```

- [ ] **Step 2: Run — verify failure**

```bash
cd services/hermes/plugins/mission-control && pytest tests/test_config.py -v
```

Expected: ModuleNotFoundError.

- [ ] **Step 3: Implement**

Write `services/hermes/plugins/mission-control/config.py`:

```python
"""Plugin config — env vars + ~/.hermes/auth.json."""
from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class Env:
    url: str
    user_pat: Optional[str]
    agent_name: Optional[str]
    board: str
    poll_interval_s: int
    bootstrap_since: str
    default_project_slug: Optional[str]
    conflict_slop_ms: int
    debug: bool


@dataclass
class Auth:
    url: str
    org_id: str
    agent_id: str
    agent_key: str
    connector_id: str
    connector_key: str
    registered_at: int
    _mtime: float = field(default=0.0, repr=False, compare=False)


def load_env() -> Optional[Env]:
    url = os.environ.get("HERMES_MC_URL", "").strip()
    if not url:
        return None
    poll = int(os.environ.get("HERMES_MC_POLL_INTERVAL", "10") or "10")
    return Env(
        url=url.rstrip("/"),
        user_pat=os.environ.get("HERMES_MC_USER_PAT") or None,
        agent_name=os.environ.get("HERMES_MC_AGENT_NAME") or None,
        board=os.environ.get("HERMES_MC_BOARD", "mc"),
        poll_interval_s=max(2, poll),
        bootstrap_since=os.environ.get("HERMES_MC_BOOTSTRAP_SINCE", "7d"),
        default_project_slug=os.environ.get("HERMES_MC_DEFAULT_PROJECT_SLUG") or None,
        conflict_slop_ms=int(os.environ.get("HERMES_MC_CONFLICT_SLOP_MS", "5000") or "5000"),
        debug=os.environ.get("HERMES_MC_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"},
    )


_cache_lock = threading.Lock()
_cache: dict[str, Auth] = {}


def _reset_cache_for_tests() -> None:
    with _cache_lock:
        _cache.clear()


def load_auth(path: Path) -> Optional[Auth]:
    path = Path(path)
    if not path.exists():
        return None
    mtime = path.stat().st_mtime
    key = str(path)
    with _cache_lock:
        cached = _cache.get(key)
        if cached and cached._mtime == mtime:
            return cached
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    block = (data.get("providers") or {}).get("mission_control")
    if not block or not block.get("agent_key"):
        return None
    auth = Auth(
        url=block["url"], org_id=block["org_id"], agent_id=block["agent_id"],
        agent_key=block["agent_key"], connector_id=block["connector_id"],
        connector_key=block["connector_key"],
        registered_at=int(block.get("registered_at", 0)),
        _mtime=mtime,
    )
    with _cache_lock:
        _cache[key] = auth
    return auth


def save_auth(path: Path, *, url: str, org_id: str, agent_id: str,
              agent_key: str, connector_id: str, connector_key: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data: dict = {}
    if path.exists():
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            data = {}
    providers = data.setdefault("providers", {})
    import time as _t
    providers["mission_control"] = {
        "url": url, "org_id": org_id, "agent_id": agent_id,
        "agent_key": agent_key, "connector_id": connector_id,
        "connector_key": connector_key,
        "registered_at": int(_t.time() * 1000),
    }
    path.write_text(json.dumps(data, indent=2))
    _reset_cache_for_tests()
```

- [ ] **Step 4: Run — verify pass**

```bash
cd services/hermes/plugins/mission-control && pytest tests/test_config.py -v
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add services/hermes/plugins/mission-control/config.py services/hermes/plugins/mission-control/tests/test_config.py
git commit -m "feat(mc plugin): config (env loading + auth.json mtime cache)

Env vars carry the HERMES_MC_ prefix all the way into the VM
(no rename) per spec rev 3. auth.json read is cached by mtime so
worker subprocesses don't hit disk on every plugin discovery."
```

---

### Task 9: `client.py` — MC HTTP client

**Files:**
- Create: `services/hermes/plugins/mission-control/client.py`
- Test: `services/hermes/plugins/mission-control/tests/test_client.py`

**Notes on test style:** use the `respx_mock` pytest fixture (NOT the `@respx.mock` decorator) — the fixture is more reliable under `asyncio_mode = "auto"` and avoids decorator-ordering edge cases observed in respx 0.21+ / httpx 0.27+. Pattern: `async def test_x(respx_mock): respx_mock.get(...).mock(return_value=...)`.

**Module-import hygiene:** none of the tests in this file should `import gateway.run` (directly or transitively) — that import sets `_HERMES_GATEWAY=1` at module load, which the conftest fixture only scrubs once-per-test (the import happens during collection). The McClient code itself never touches gateway code, so this is naturally safe; if a future test pulls in gateway-side helpers, scrub `_HERMES_GATEWAY` explicitly inside the test body after the import.

- [ ] **Step 1: Write failing tests**

```python
from __future__ import annotations

import httpx
import pytest

from mission_control import client as mc_client


BASE = "https://mc.example.com"


def _make_client():
    return mc_client.McClient(base_url=BASE, timeout_s=2.0)


async def test_me_with_agent_key(respx_mock):
    route = respx.get(f"{BASE}/v1/me").mock(
        return_value=httpx.Response(200, json={"org": {"id": "org_1"},
                                                "principal_type": "agent",
                                                "principal_id": "agt_1"}))
    c = _make_client()
    result = await c.me("mcagt_xxx")
    assert result["principal_id"] == "agt_1"
    assert route.called
    assert route.calls.last.request.headers["authorization"] == "Bearer mcagt_xxx"


async def test_tasks_list_passes_filters(respx_mock):
    respx_mock.get(f"{BASE}/v1/tasks").mock(
        return_value=httpx.Response(200, json={"data": [], "next_cursor": "abc"}))
    c = _make_client()
    result = await c.tasks_list(agent_key="mcagt_x", agent_id="agt_1",
                                 updated_since=12345, limit=100)
    call = respx.calls.last.request
    assert "agent_id=agt_1" in str(call.url)
    assert "updated_since=12345" in str(call.url)
    assert result["next_cursor"] == "abc"


async def test_tasks_create_idempotency_header(respx_mock):
    respx_mock.post(f"{BASE}/v1/tasks").mock(
        return_value=httpx.Response(201, json={"id": "t_new", "updated_at": 999}))
    c = _make_client()
    result = await c.tasks_create(connector_key="mccnn_x",
                                   project_id="prj_1", title="t",
                                   agent_id="agt_1",
                                   idempotency_key="hermes:abc",
                                   metadata={"origin": "hermes"})
    call = respx.calls.last.request
    assert call.headers["idempotency-key"] == "hermes:abc"
    assert result["id"] == "t_new"


async def test_tasks_patch(respx_mock):
    respx_mock.patch(f"{BASE}/v1/tasks/t_1").mock(
        return_value=httpx.Response(200, json={"id": "t_1", "updated_at": 1000}))
    c = _make_client()
    result = await c.tasks_patch(agent_key="mcagt_x", mc_task_id="t_1",
                                  status="in_progress", metadata={"k": "v"})
    assert result["updated_at"] == 1000


async def test_comments_list_cursor(respx_mock):
    respx_mock.get(f"{BASE}/v1/tasks/t_1/comments").mock(
        return_value=httpx.Response(200, json={"data": [], "next_cursor": "c2"}))
    c = _make_client()
    r = await c.task_comments_list(agent_key="mcagt_x", mc_task_id="t_1",
                                    cursor="c1", limit=100)
    call = respx.calls.last.request
    assert "cursor=c1" in str(call.url)
    assert r["next_cursor"] == "c2"


async def test_comment_create_idempotency_header(respx_mock):
    respx_mock.post(f"{BASE}/v1/tasks/t_1/comments").mock(
        return_value=httpx.Response(201, json={"id": "cmt_1"}))
    c = _make_client()
    r = await c.task_comment_create(key="mcagt_x", mc_task_id="t_1",
                                     body="hi",
                                     idempotency_key="hermes:cmt:42")
    call = respx.calls.last.request
    assert call.headers["idempotency-key"] == "hermes:cmt:42"
    assert r["id"] == "cmt_1"


async def test_external_ref_create_idempotency_header(respx_mock):
    respx_mock.post(f"{BASE}/v1/external_refs").mock(
        return_value=httpx.Response(201, json={"id": "xrf_1"}))
    c = _make_client()
    r = await c.external_ref_create(agent_key="mcagt_x",
                                     resource_type="task", resource_id="t_1",
                                     source_kind="hermes", source_id="agt_1",
                                     external_id="local_abc",
                                     idempotency_key="hermes:xrf:local_abc")
    call = respx.calls.last.request
    assert call.headers["idempotency-key"] == "hermes:xrf:local_abc"


async def test_401_raises_auth_failed(respx_mock):
    respx_mock.get(f"{BASE}/v1/me").mock(
        return_value=httpx.Response(401, json={"error": {"code": "auth.invalid"}}))
    c = _make_client()
    with pytest.raises(mc_client.AuthFailed):
        await c.me("mcagt_bad")


async def test_5xx_raises_transient(respx_mock):
    respx_mock.get(f"{BASE}/v1/me").mock(return_value=httpx.Response(503))
    c = _make_client()
    with pytest.raises(httpx.HTTPStatusError):
        await c.me("mcagt_x")


async def test_409_with_existing_id_surfaces_in_error(respx_mock):
    respx_mock.post(f"{BASE}/v1/tasks").mock(
        return_value=httpx.Response(409, json={"error": {
            "code": "idempotency.conflict",
            "details": {"existing_task_id": "t_dupe"},
        }}))
    c = _make_client()
    with pytest.raises(mc_client.IdempotencyConflict) as exc:
        await c.tasks_create(connector_key="mccnn_x", project_id="p",
                              title="t", agent_id="a", idempotency_key="x",
                              metadata={})
    assert exc.value.existing_task_id == "t_dupe"


async def test_agents_create_returns_id_and_key(respx_mock):
    respx_mock.post(f"{BASE}/v1/agents").mock(
        return_value=httpx.Response(201, json={
            "agent": {"id": "agt_new"},
            "key": "mcagt_secret",
        }))
    c = _make_client()
    r = await c.agents_create(pat="mcpat_x", name="vm1", kind="hermes")
    assert r["agent"]["id"] == "agt_new"
    assert r["key"] == "mcagt_secret"


async def test_connectors_create_returns_id_and_key(respx_mock):
    respx_mock.post(f"{BASE}/v1/connectors").mock(
        return_value=httpx.Response(201, json={
            "connector": {"id": "cnn_new"},
            "key": "mccnn_secret",
        }))
    c = _make_client()
    r = await c.connectors_create(pat="mcpat_x", name="vm1", kind="hermes")
    assert r["connector"]["id"] == "cnn_new"


async def test_projects_list_returns_data(respx_mock):
    respx_mock.get(f"{BASE}/v1/projects").mock(
        return_value=httpx.Response(200, json={"data": [{"id": "prj_1", "slug": "p", "name": "P"}],
                                                "next_cursor": "tip"}))
    c = _make_client()
    r = await c.projects_list(pat="mcpat_x")
    assert len(r["data"]) == 1
```

- [ ] **Step 2: Run — verify failure**

```bash
cd services/hermes/plugins/mission-control && pytest tests/test_client.py -v
```

- [ ] **Step 3: Implement**

Write `services/hermes/plugins/mission-control/client.py`:

```python
"""httpx-based async client for the MissionControl HTTP API."""
from __future__ import annotations

import httpx
from typing import Any, Optional


class AuthFailed(Exception):
    """401 / 403 from MC. Triggers loop shutdown until re-registration."""


class IdempotencyConflict(Exception):
    """409 idempotency.conflict — body has details.existing_task_id."""
    def __init__(self, existing_task_id: Optional[str] = None, body: Optional[dict] = None):
        self.existing_task_id = existing_task_id
        self.body = body or {}
        super().__init__(f"idempotency conflict (existing_task_id={existing_task_id})")


class StateMachineConflict(Exception):
    """409 task.invalid_transition or similar."""


class NotFound(Exception):
    """404 — typically means the MC task was deleted upstream."""


class McClient:
    def __init__(self, base_url: str, timeout_s: float = 10.0):
        self._base = base_url.rstrip("/")
        self._timeout = timeout_s
        self._client = httpx.AsyncClient(timeout=timeout_s)

    async def aclose(self) -> None:
        await self._client.aclose()

    # ── HTTP helper ─────────────────────────────────────────────────

    async def _request(self, method: str, path: str, *, key: str,
                       params: Optional[dict] = None,
                       json_body: Optional[dict] = None,
                       headers: Optional[dict] = None) -> dict:
        h = {"Authorization": f"Bearer {key}"}
        if headers:
            h.update(headers)
        try:
            resp = await self._client.request(method, f"{self._base}{path}",
                                              params=params, json=json_body, headers=h)
        except httpx.RequestError:
            raise
        if resp.status_code in (401, 403):
            raise AuthFailed(f"{resp.status_code} {resp.text}")
        if resp.status_code == 404:
            raise NotFound(resp.text)
        if resp.status_code == 409:
            try:
                body = resp.json()
            except Exception:
                body = {}
            err = body.get("error", {}) if isinstance(body, dict) else {}
            if err.get("code") == "idempotency.conflict":
                raise IdempotencyConflict(
                    existing_task_id=(err.get("details") or {}).get("existing_task_id"),
                    body=body,
                )
            raise StateMachineConflict(str(body))
        if resp.status_code >= 500:
            resp.raise_for_status()
        if resp.status_code >= 400:
            resp.raise_for_status()
        return resp.json() if resp.content else {}

    # ── endpoints ───────────────────────────────────────────────────

    async def me(self, key: str) -> dict:
        return await self._request("GET", "/v1/me", key=key)

    async def tasks_list(self, *, agent_key: str, agent_id: Optional[str] = None,
                         updated_since: Optional[int] = None,
                         cursor: Optional[str] = None, limit: int = 100,
                         status: Optional[str] = None) -> dict:
        params: dict = {"limit": limit}
        if agent_id is not None:
            params["agent_id"] = agent_id
        if updated_since is not None:
            params["updated_since"] = updated_since
        if cursor is not None:
            params["cursor"] = cursor
        if status is not None:
            params["status"] = status
        return await self._request("GET", "/v1/tasks", key=agent_key, params=params)

    async def tasks_get(self, *, key: str, mc_task_id: str) -> dict:
        return await self._request("GET", f"/v1/tasks/{mc_task_id}", key=key)

    async def tasks_create(self, *, connector_key: str, project_id: str,
                           title: str, body: Optional[str] = None,
                           agent_id: Optional[str] = None,
                           metadata: Optional[dict] = None,
                           idempotency_key: Optional[str] = None) -> dict:
        body_json = {"project_id": project_id, "title": title}
        if body is not None:
            body_json["body"] = body
        if agent_id is not None:
            body_json["agent_id"] = agent_id
        if metadata is not None:
            body_json["metadata"] = metadata
        if idempotency_key is not None:
            body_json["idempotency_key"] = idempotency_key
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return await self._request("POST", "/v1/tasks", key=connector_key,
                                    json_body=body_json, headers=headers)

    async def tasks_patch(self, *, agent_key: str, mc_task_id: str,
                          status: Optional[str] = None,
                          metadata: Optional[dict] = None,
                          title: Optional[str] = None,
                          body: Optional[str] = None) -> dict:
        body_json: dict = {}
        if status is not None:
            body_json["status"] = status
        if metadata is not None:
            body_json["metadata"] = metadata
        if title is not None:
            body_json["title"] = title
        if body is not None:
            body_json["body"] = body
        return await self._request("PATCH", f"/v1/tasks/{mc_task_id}",
                                    key=agent_key, json_body=body_json)

    async def task_comments_list(self, *, agent_key: str, mc_task_id: str,
                                  cursor: Optional[str] = None,
                                  limit: int = 100) -> dict:
        params: dict = {"limit": limit}
        if cursor is not None:
            params["cursor"] = cursor
        return await self._request("GET", f"/v1/tasks/{mc_task_id}/comments",
                                    key=agent_key, params=params)

    async def task_comment_create(self, *, key: str, mc_task_id: str,
                                   body: str,
                                   idempotency_key: Optional[str] = None) -> dict:
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return await self._request("POST", f"/v1/tasks/{mc_task_id}/comments",
                                    key=key, json_body={"body": body}, headers=headers)

    async def external_ref_create(self, *, agent_key: str,
                                   resource_type: str, resource_id: str,
                                   source_kind: str, source_id: str,
                                   external_id: str,
                                   external_url: Optional[str] = None,
                                   metadata: Optional[dict] = None,
                                   idempotency_key: Optional[str] = None) -> dict:
        body: dict = {
            "resource_type": resource_type, "resource_id": resource_id,
            "source_kind": source_kind, "source_id": source_id,
            "external_id": external_id,
        }
        if external_url is not None:
            body["external_url"] = external_url
        if metadata is not None:
            body["metadata"] = metadata
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return await self._request("POST", "/v1/external_refs", key=agent_key,
                                    json_body=body, headers=headers)

    async def agents_list(self, *, pat: str) -> dict:
        return await self._request("GET", "/v1/agents", key=pat)

    async def agents_create(self, *, pat: str, name: str, kind: str,
                            description: Optional[str] = None) -> dict:
        body: dict = {"name": name, "kind": kind}
        if description is not None:
            body["description"] = description
        return await self._request("POST", "/v1/agents", key=pat, json_body=body)

    async def agents_rotate_key(self, *, pat: str, agent_id: str) -> dict:
        return await self._request("POST", f"/v1/agents/{agent_id}/rotate-key",
                                    key=pat)

    async def connectors_list(self, *, pat: str) -> dict:
        return await self._request("GET", "/v1/connectors", key=pat)

    async def connectors_create(self, *, pat: str, name: str, kind: str,
                                description: Optional[str] = None) -> dict:
        body: dict = {"name": name, "kind": kind}
        if description is not None:
            body["description"] = description
        return await self._request("POST", "/v1/connectors", key=pat, json_body=body)

    async def connectors_rotate_key(self, *, pat: str, connector_id: str) -> dict:
        return await self._request("POST", f"/v1/connectors/{connector_id}/rotate-key",
                                    key=pat)

    async def projects_list(self, *, pat: str,
                            cursor: Optional[str] = None,
                            limit: int = 100) -> dict:
        params: dict = {"limit": limit}
        if cursor is not None:
            params["cursor"] = cursor
        return await self._request("GET", "/v1/projects", key=pat, params=params)
```

- [ ] **Step 4: Run — verify pass**

```bash
cd services/hermes/plugins/mission-control && pytest tests/test_client.py -v
```

- [ ] **Step 5: Commit**

```bash
git add services/hermes/plugins/mission-control/client.py services/hermes/plugins/mission-control/tests/test_client.py
git commit -m "feat(mc plugin): client (httpx-based MC HTTP wrapper)

Async client covering /v1/me, tasks (list/get/create/patch), comments
(list/create), external_refs, agents+connectors lifecycle, and projects
list. Typed exceptions for the common failure modes: AuthFailed,
IdempotencyConflict (carries existing_task_id), StateMachineConflict,
NotFound. Idempotency-Key header included on POSTs that need it."
```

---

## Phase 5 — Apply, Pull, Push

Tasks 10–14 follow the same TDD pattern. Per-task summary:

### Task 10: `apply.py` — MC → local writes

**Files:**
- Create: `services/hermes/plugins/mission-control/apply.py`
- Test: `services/hermes/plugins/mission-control/tests/test_apply.py`

Behavior:
- `handle_one_task(ldb_conn, kanban_conn, env, auth, mc_task)`: implements the 4-case dispatch from spec §"Pull loop":
  - No link + MC state in {ready, in_progress, blocked} → `kanban_db.create_task(..., initial_status='ready', tenant=f'mc:{org}:{prj}', idempotency_key=f'mc:{mc_task_id}', board=env.board)`, insert link, POST external_ref, record apply.
  - No link + MC state in {pending, completed, failed, cancelled} → skip.
  - Link source='pulled' + newer mc updated_at → apply via status_map.mc_to_local() + appropriate kanban_db helper; capture event ids via pre/post-MAX range; record_apply for each; update_link_state.
  - Link source='pushed' + mc updated_at > last_pushed + slop → conflict; log WARN; apply same as pulled-update.
  - Otherwise → no-op, update last_pulled_at.
- `handle_one_comment(ldb_conn, kanban_conn, link, mc_comment)`:
  - If `comment_has_mc(mc_comment.id)` → skip.
  - Else: pre_max → `kanban_db.add_comment(conn, link.local_task_id, author=f'mission-control:{author_type}:{author_id}', body=...)` → post_max → record apply rows → `insert_comment_link(source='pulled')` → if link.local_status == 'blocked': add system comment "auto-unblock: …" → `kanban_db.unblock_task(conn, link.local_task_id)` → record apply rows → `update_link_state(local_status='ready')`.

Tests cover: each of the 4 task-dispatch cases; orphan-link 404 path; auto-unblock fires only on blocked; mc_apply_log gets the right event ids; comment dedup skips already-pulled comments; external_ref POST happens only on first link.

Use a real `kanban_db.connect(":memory:")` for kanban interactions (the kanban schema is created lazily by `connect`); use `links_db.connect(":memory:")` for links. Mock `client.McClient` with respx where HTTP is involved.

Commit:

```
feat(mc plugin): apply (MC→local writes via kanban_db helpers)

handle_one_task covers all 4 link/state combinations from the spec;
handle_one_comment dedupes via mc_comment_links and auto-unblocks
blocked tasks. Event-id capture uses pre/post-MAX range to feed
mc_apply_log without races.
```

### Task 11: `pull.py` — pull loop

**Files:**
- Create: `services/hermes/plugins/mission-control/pull.py`
- Test: `services/hermes/plugins/mission-control/tests/test_pull.py`

Behavior:
- Single async function `pull_once(env, auth, ldb_conn, kanban_conn, client)`: runs ONE pull cycle (tasks then comments) and returns counts. Splitting from the long-running loop makes testing trivial.
- Loop wrapper `pull_loop(env, auth, ldb_conn, kanban_conn, client, stop_event)`: while not stop_event: try pull_once + backoff_reset; except transient: backoff; except AuthFailed: set status, return.
- Tasks phase: drain `client.tasks_list` paging via `cursor=`, advance `highest = max(highest, mc_task.updated_at)` per row, call `apply.handle_one_task` per row.
- Comments phase: for each `link in links_db.list_active_links(ldb_conn)`, page comments forward from `link.last_comment_cursor`. After each page (including empty), save `next_cursor` to the link. Break when data is empty.
- After both phases succeed: `set_pull_cursor('tasks', highest)`, then `purge_apply_log(older_than_ms=24*3600*1000)`.

Tests use respx_mock fixture to mock MC, real in-memory DBs. Required test cases:
- Happy path: one new MC task → local kanban row created with `board=env.board`, link inserted, external_ref POSTed.
- 401 mid-pull: loop catches AuthFailed, sets status='auth_failed', exits, does NOT advance cursor.
- 5xx mid-pull: backoff schedule honored (use a fake sleep to assert delays of ~5s, ~30s, ~120s with ±25% jitter on consecutive failures; reset to 0 after a success).
- Tasks-cursor stays unchanged when the comments phase raises (partial-failure recovery).
- `kanban_db.connect` always called with `board=env.board` (assert via monkeypatch wrapper that captures kwargs).
- Round-trip with push: pull creates task → simulate dispatcher's `claimed` event → push's PATCH lands at MC with `status=in_progress` → next pull sees the echoed updated_at and is a no-op via mc_apply_log.

Commit:

```
feat(mc plugin): pull loop

Drains MC tasks since cursor, then per-active-link comment cursors.
Both-phase cursor advance is atomic — partial failures leave cursors
intact for retry. Idle housekeeping purges mc_apply_log entries >24h.
```

### Task 12: `push.py` — push reactor

**Files:**
- Create: `services/hermes/plugins/mission-control/push.py`
- Test: `services/hermes/plugins/mission-control/tests/test_push.py`

Behavior:
- `push_once(env, auth, ldb_conn, kanban_conn, client) -> int` (returns events processed): reads `kanban_db.list_events_since(kanban_conn, last_id, limit=200)`, filters via `is_in_apply_log` + author-prefix check, dispatches each event via the kind→handler map, then advances `set_pull_cursor('events', last_id)`.
- Per-event handlers:
  - status events (claimed/blocked/unblocked/archived/scheduled): build PATCH body via `status_map.event_kind_to_patch`; call `client.tasks_patch`; on success update `link.last_pushed_at = response.updated_at` + `last_terminal_state` if terminal.
  - `completed`: look up `kanban_db.latest_run(conn, ev.task_id)`, pass `run.outcome` into `event_kind_to_patch`, PATCH.
  - `commented`: skip if comment id is already in `mc_comment_links` or if author starts with `mission-control:`; else `client.task_comment_create(key=agent_key, idempotency_key=f'hermes:cmt:{local_comment_id}')` and on success `insert_comment_link(source='pushed')`.
- Loop wrapper `push_loop(env, auth, ldb_conn, kanban_conn, client, stop_event)`: same shape as pull_loop.

Tests cover (mandatory):
- Each event-kind path (claimed/blocked/unblocked/archived/scheduled/completed/completion_blocked_hallucination/commented).
- `completed` event outcome disambiguation: assert `kanban_db.latest_run` is called for the task; with `outcome='completed'` PATCH sends `status=completed`; with `outcome='crashed'` (and each other failure outcome) PATCH sends `status=failed` with `failure_reason` populated.
- Comment dedup BOTH via `mc_comment_links.has_local()` AND via `author.startswith('mission-control:')` — separate test for each path.
- 409 state-machine conflict (e.g. PATCH `completed` on a task MC already marked `cancelled`): re-pull MC's canonical state, apply locally, clear `push_dirty`.
- 404 from MC: orphan-link delete + local task archive with `result='removed from mc'`.
- Idempotency-Key header present on every comment POST (`hermes:cmt:<local_id>`).
- Auth: agent_key used for PATCH and comment_create; agent_key used for external_ref (matches spec §"Idempotency summary").

Commit:

```
feat(mc plugin): push reactor

Tails kanban task_events on the MC-pinned board, skips events in
mc_apply_log (anti-feedback), maps each kind via status_map and
PATCHes MC. completed events use latest_run.outcome to disambiguate
success vs failure. Comments dedup via mc_comment_links + author prefix.
```

### Task 13: `runtime.py` — daemon thread

**Files:**
- Create: `services/hermes/plugins/mission-control/runtime.py`
- Test: `services/hermes/plugins/mission-control/tests/test_runtime.py`

Behavior:
- `start(env, auth, ldb_conn_factory, kanban_conn_factory, client_factory)` → starts a daemon thread that calls `asyncio.run(_run_both(...))`.
- `_run_both()` opens loop-scoped resources (links_db conn, kanban_db conn, McClient) and `await asyncio.gather(pull_loop(...), push_loop(...))`.
- Module-level `_status` dict tracks `loops_running`, last success times, error counts; exported via `get_status()`.
- `stop()` sets the stop event (mostly for tests; production never calls).

Test: `test_runtime.start_runs_loops_in_a_daemon_thread`. Sketch:

```python
import asyncio
import time

from mission_control import runtime


def test_start_runs_loops_in_a_daemon_thread(monkeypatch, tmp_path):
    pull_calls, push_calls = [], []

    async def fake_pull_loop(*args, stop_event, **kw):
        while not stop_event.is_set():
            pull_calls.append(time.time())
            await asyncio.sleep(0.05)

    async def fake_push_loop(*args, stop_event, **kw):
        while not stop_event.is_set():
            push_calls.append(time.time())
            await asyncio.sleep(0.05)

    # Patch at the runtime module's namespace (where they're referenced),
    # not where pull_loop/push_loop are defined.
    monkeypatch.setattr("mission_control.runtime.pull_loop", fake_pull_loop)
    monkeypatch.setattr("mission_control.runtime.push_loop", fake_push_loop)

    runtime.start(env=None, auth=None,
                  ldb_conn_factory=lambda: None,
                  kanban_conn_factory=lambda: None,
                  client_factory=lambda: None)
    time.sleep(0.2)
    assert runtime.get_status()["loops_running"] is True
    assert len(pull_calls) >= 2
    assert len(push_calls) >= 2

    runtime.stop()
    time.sleep(0.1)
    assert runtime.get_status()["loops_running"] is False
```

Commit:

```
feat(mc plugin): runtime (daemon thread owning the asyncio loops)

asyncio.run inside a daemon thread — matches the agents-observe pattern
and avoids the 'register() runs before any event loop exists' issue
flagged in spec review. Exposes get_status() for the dashboard widget.
```

### Task 14: `registrar.py` — PAT-driven registration

**Files:**
- Create: `services/hermes/plugins/mission-control/registrar.py`
- Test: `services/hermes/plugins/mission-control/tests/test_registrar.py`

Behavior:
- `register(env, auth_path, pat, name=None, bootstrap_since='7d') -> Auth`:
  1. With PAT, call `client.agents_list()` and `connectors_list()` to find any with `name == requested_name`.
  2. Agent: if exists → `agents_rotate_key`; else → `agents_create`. Same for connector.
     - If `connectors_create` returns 404 / 403 → raise `ConnectorRoutesUnavailable` with the named-error-code message from the spec.
  3. Call `client.me(agent_key)` to get `org_id` (alternatively included in agent response).
  4. Save to `auth.json` via `config.save_auth(...)`.
  5. Fetch project list via `client.projects_list(pat)`, paginate, write to `~/.hermes/mission-control/projects.json`.
  6. Return Auth.
- `refresh_projects(pat, projects_path)`: same as step 5 only.

Tests use respx + tmp_path; cover happy path, agent-already-exists rotation, connector 404 → ConnectorRoutesUnavailable, 401 PAT → AuthFailed propagated.

Commit:

```
feat(mc plugin): registrar (PAT → agent + connector keys)

Idempotent: reruns rotate existing keys instead of creating new agents.
Hard-fails with mc.connector_routes_unavailable when POST /v1/connectors
returns 404/403 (rather than silently registering agent-only — the
plugin's promote path requires the connector).
```

---

## Phase 6 — Tool + CLI + Entry point

### Task 15: `tools.py` — `mc_promote_task`

**Files:**
- Create: `services/hermes/plugins/mission-control/tools.py`
- Test: `services/hermes/plugins/mission-control/tests/test_tools.py`

Behavior:
- `mc_promote_task(local_task_id, project_slug=None)`:
  1. Load env + auth; if either missing → error "plugin not registered".
  2. Resolve `project_slug` (default to `env.default_project_slug`) → `project_id` via cached `projects.json`.
  3. Check `links_db.get_link(local_task_id)` — if present, return `{mc_task_id, already_linked: True}`.
  4. Read local kanban task via `kanban_db.connect(board=env.board)` + `kanban_db.get_task(conn, local_task_id)`.
  5. `client.tasks_create(connector_key=auth.connector_key, project_id=project_id, title=task.title, body=task.body, agent_id=auth.agent_id, idempotency_key=f'hermes:{local_task_id}', metadata={'origin': 'hermes'})`.
  6. On IdempotencyConflict whose existing_task_id matches our link table: treat as already_linked.
  7. On success: `links_db.insert_link(source='pushed')`, then `client.external_ref_create(agent_key, source_kind='hermes', source_id=auth.agent_id, external_id=local_task_id, idempotency_key=f'hermes:xrf:{local_task_id}')`.
  8. Return `{mc_task_id, already_linked: False}`.

Tests cover:
- Happy path: local task → MC POST → link inserted with `source='pushed'` → external_ref POSTed with **agent key** (not connector key) + correct idempotency-key header.
- Already-linked: re-call returns `{mc_task_id: existing, already_linked: True}` without re-POSTing.
- Idempotency conflict whose `details.existing_task_id` matches the local link's `mc_task_id`: treat as success, return `already_linked=True`.
- Idempotency conflict whose `existing_task_id` does NOT match our link (or no link exists): log ERROR + raise to caller.
- Unknown slug: friendly error pointing at `hermes mc refresh-projects`.
- No env / no auth: clear error "plugin not registered".

Commit:

```
feat(mc plugin): mc_promote_task tool

LLM-callable + reused by `hermes mc promote` CLI. Idempotent on local
task id; surfaces a 409 with matching existing_task_id as success.
Uses connector key for POST /v1/tasks and agent key for external_ref.
```

### Task 16: `cli.py` — `hermes mc <subcommand>`

**Files:**
- Create: `services/hermes/plugins/mission-control/cli.py`
- Test: `services/hermes/plugins/mission-control/tests/test_cli.py`

Subcommands: `register`, `status`, `refresh-projects`, `promote`, `unlink`, `test`. Use `argparse` (the standard pattern for Hermes CLI extensions — see other plugins' CLI files).

Behavior summaries:
- `register`: reads PAT from `--pat` or env, calls `registrar.register`, prints summary.
- `status`: reads auth.json, prints connection block + last-cursor + queue depth (from runtime.get_status()).
- `refresh-projects`: reads PAT, calls `registrar.refresh_projects`.
- `promote <task_id> [--project <slug>]`: calls `tools.mc_promote_task` directly.
- `unlink <task_id>`: `links_db.delete_link(local_task_id)`; warns "MC task not deleted; use MC API."
- `test`: calls `client.me()` with both keys + `tasks_list(limit=1)`; exits 0 on success, non-zero with named error on fail.

Tests: each subcommand parses correctly and invokes the right helper (mock with monkeypatch).

Commit:

```
feat(mc plugin): hermes mc CLI subcommand surface

register, status, refresh-projects, promote, unlink, test — all wrap
the underlying helpers; each is tested for argparse + dispatch.
```

### Task 17: `__init__.py` — `register(ctx)` entry point

**Files:**
- Modify: `services/hermes/plugins/mission-control/__init__.py`
- Test: `services/hermes/plugins/mission-control/tests/test_loop_guard.py`

Behavior:
- `register(ctx)`:
  1. Load env via `config.load_env()`. If None → log INFO "HERMES_MC_URL unset; plugin inert" + return.
  2. Register the `mc_promote_task` tool (via `ctx.register_tool(...)`) — unconditional, so worker subprocesses get it.
  3. Register the `mc` CLI subcommand (via `ctx.register_cli_command(name='mc', help='MissionControl integration', setup_fn=cli._setup, handler_fn=cli._handler)`).
  4. Loop-startup guard: `if os.environ.get("_HERMES_GATEWAY") != "1" or os.environ.get("HERMES_KANBAN_TASK"): return`.
  5. Load auth via `config.load_auth(...)`. If None → log "not registered; loops not started" + set status='not_registered' + return.
  6. Start the daemon thread via `runtime.start(env, auth, ...)`.

Test `test_loop_guard.py`:
- With `HERMES_MC_URL` unset → `register(ctx)` is a no-op.
- With `HERMES_MC_URL` set + `_HERMES_GATEWAY` unset → registers tool + CLI, but loops are NOT started.
- With `HERMES_MC_URL` set + `_HERMES_GATEWAY=1` + `HERMES_KANBAN_TASK` set → registers tool + CLI, loops NOT started.
- With `HERMES_MC_URL` set + `_HERMES_GATEWAY=1` + no `HERMES_KANBAN_TASK` + auth.json present → loops started.
- With same env + auth.json missing → no loops; status='not_registered'.

Commit:

```
feat(mc plugin): register(ctx) entry point with gateway-guard

Tool + CLI register unconditionally so worker subprocesses can call
mc_promote_task. Loops only start when running in the gateway
(_HERMES_GATEWAY=1) AND not a worker (HERMES_KANBAN_TASK unset)
AND auth.json has been written.
```

---

## Phase 7 — Dashboard widget

### Task 18: `dashboard/` — status endpoint only (v1 ships without React UI)

**Files:**
- Create: `services/hermes/plugins/mission-control/dashboard/__init__.py` (empty)
- Create: `services/hermes/plugins/mission-control/dashboard/manifest.json`
- Create: `services/hermes/plugins/mission-control/dashboard/plugin_api.py`
- Test: `services/hermes/plugins/mission-control/tests/test_dashboard_api.py`

`manifest.json`:

```json
{
  "name": "mission-control",
  "label": "MissionControl",
  "description": "Sync status with MissionControl",
  "icon": "Cloud",
  "version": "1.0.0",
  "widget": {
    "host": "settings",
    "position": "after:plugins"
  },
  "api": "plugin_api.py"
}
```

`plugin_api.py`:

```python
"""Dashboard plugin API — exposes mission-control's runtime status.

v1 ships the API only; the React widget bundle is deferred to v1.1
once the upstream dashboard plugin-bundle pipeline is documented in
hermes. Operators get the same info via `hermes mc status`.
"""
from __future__ import annotations

from fastapi import APIRouter

from mission_control import config, runtime, links_db
from pathlib import Path

router = APIRouter()


@router.get("/status")
async def status() -> dict:
    env = config.load_env()
    auth = config.load_auth(Path.home() / ".hermes" / "auth.json")
    runtime_status = runtime.get_status()

    base = {
        "registered": auth is not None,
        "url": auth.url if auth else (env.url if env else None),
        "org_id": auth.org_id if auth else None,
        "agent_id": auth.agent_id if auth else None,
        "connector_id": auth.connector_id if auth else None,
        "loops_running": runtime_status.get("loops_running", False),
        "last_pull_ok_at": runtime_status.get("last_pull_ok_at"),
        "last_push_ok_at": runtime_status.get("last_push_ok_at"),
        "consecutive_pull_errors": runtime_status.get("consecutive_pull_errors", 0),
        "consecutive_push_errors": runtime_status.get("consecutive_push_errors", 0),
        "queue_depth": runtime_status.get("queue_depth", 0),
        "links_total": 0,
        "links_dirty": 0,
        "recent_errors": runtime_status.get("recent_errors", []),
    }
    if auth:
        try:
            ldb = links_db.connect(str(Path.home() / ".hermes" / "mission-control" / "links.db"))
            base["links_total"] = ldb.execute("SELECT COUNT(*) FROM mc_links").fetchone()[0]
            base["links_dirty"] = ldb.execute("SELECT COUNT(*) FROM mc_links WHERE push_dirty = 1").fetchone()[0]
            ldb.close()
        except Exception:
            pass
    return base
```

Test mocks `config.load_env / load_auth / runtime.get_status` and asserts the response shape.

Commit:

```
feat(mc plugin): dashboard status endpoint (no React widget in v1)

GET /api/plugins/mission-control/status returns the connection +
runtime state for the dashboard settings widget. React UI deferred
to v1.1 once upstream's dashboard plugin-bundle pipeline is documented.
```

---

## Phase 8 — Stack-side wiring

### Task 19: `build.sh` — `hermes_sync_plugin` + `hermes_enable_plugin` helpers

**Files:**
- Modify: `services/hermes/build.sh`
- Test: `services/hermes/build.test.sh`

`hermes_sync_plugin <name>`:
- When `HERMES_MOUNT_ENABLED=true`: `rsync -a --delete services/hermes/plugins/<name>/ "$MAC_HERMES/plugins/<name>/"`.
- When false: warn + print the equivalent `orb -m bash -lc 'rsync ...'` command.

`hermes_enable_plugin <name>`:
- Same mount-aware pattern. Reads `~/.hermes/config.yaml` via python3 + pyyaml round-trip (same as the agentmemory section does for `mcp_servers`), appends `<name>` to `plugins.enabled` if missing, writes back.

Test (follow the existing `build.test.sh` pattern at lines 22-46 that slices `hermes_env_rewrite_managed_block`):

```bash
test_hermes_enable_plugin_idempotent() {
  local tmp=$(mktemp -d)
  cat > "$tmp/config.yaml" <<EOF
plugins:
  enabled:
    - agents-observe
EOF

  # Extract the function out of build.sh so we can call it in isolation
  local helper="$(sed -n '/^hermes_enable_plugin() {/,/^}$/p' services/hermes/build.sh)"
  eval "$helper"

  # Stub mount + paths so the helper writes to our tmpdir
  HERMES_MOUNT_ENABLED=true
  MAC_HERMES="$tmp"

  hermes_enable_plugin "mission-control"
  hermes_enable_plugin "mission-control"  # second call → idempotent

  python3 -c "
import yaml
d = yaml.safe_load(open('$tmp/config.yaml'))
enabled = d['plugins']['enabled']
assert enabled.count('mission-control') == 1, enabled
assert 'agents-observe' in enabled, enabled
"
  rm -rf "$tmp"
}
```

The `sed -n '/^func() {/,/^}$/p'` extraction pattern mirrors the existing `hermes_env_rewrite_managed_block` test fixture. Requires `python3` + `pyyaml` available on the build host (already required by other build.sh paths — agentmemory section uses the same).

Commit:

```
feat(hermes build): hermes_sync_plugin + hermes_enable_plugin helpers

Generic helpers used by the mission-control wiring in the next commit.
Both are mount-aware (degrade gracefully when HERMES_MOUNT_ENABLED=false
by printing the equivalent orb -m command).
```

### Task 20: `build.sh` — mission-control lever section

**Files:**
- Modify: `services/hermes/build.sh`
- Test: `services/hermes/build.test.sh`

Add the conditional block from spec §"Build.sh wiring" — read `HERMES_MC_URL` from `.stack/.env` (already sourced earlier in build.sh), append the eight `HERMES_MC_*` vars to `HERMES_ENV_MANAGED`, conditionally append `HERMES_MC_USER_PAT` when set, then call the two helpers.

Test cases for `build.test.sh`:
- HERMES_MC_URL set, USER_PAT set → managed block contains all keys including PAT; plugin is rsynced; config.yaml has mission-control in plugins.enabled.
- HERMES_MC_URL set, USER_PAT unset → no PAT line in managed block.
- HERMES_MC_URL unset → no MC lines in managed block; plugin not synced; warn-line in build output.
- Second build with same state → idempotent (managed block byte-identical; plugins.enabled unchanged).

Commit:

```
feat(hermes build): mission-control lever section

Conditional on HERMES_MC_URL — writes HERMES_MC_* env into the
managed block, syncs the plugin into ~/.hermes/plugins/, enables it
in config.yaml. PAT is included only while still in .stack/.env so
operators can clear it after first-run registration.
```

---

## Phase 9 — Documentation

### Task 21: Plugin README

**Files:**
- Modify: `services/hermes/plugins/mission-control/README.md`

Replace the placeholder with operator-focused docs:
- What the plugin does (one paragraph + the diagram from the spec).
- One-time setup flow:
  1. Get a PAT from MC (instructions or link).
  2. Set `HERMES_MC_URL` and `HERMES_MC_USER_PAT` in `.stack/.env`.
  3. `just build hermes` (syncs plugin, writes env).
  4. SSH into VM or use `orb -m`: `hermes mc register`.
  5. Verify: `hermes mc status` shows `registered: true` and `loops_running: true`.
  6. Clear `HERMES_MC_USER_PAT` from `.stack/.env`; `just build` again.
- Day-to-day commands (one-liner each from the CLI surface).
- Troubleshooting: 401 = re-register; 503 = check MC reachability; tasks not arriving = check `hermes mc status` for cursor + errors.

Commit:

```
docs(mc plugin): operator README
```

### Task 22: Update `services/hermes/README.md`

**Files:**
- Modify: `services/hermes/README.md`

Add a row to the existing Levers table for `HERMES_MC_URL` + a "MissionControl" bullet under the "Auto-wired by `services/hermes/build.sh` when the relevant profile is active" section.

Commit:

```
docs(hermes svc): mention HERMES_MC_URL lever in README
```

---

## Phase 10 — Integration (optional, marker-gated)

### Task 23: `tests/integration/test_end_to_end.py`

**Files:**
- Create: `services/hermes/plugins/mission-control/tests/integration/__init__.py`
- Create: `services/hermes/plugins/mission-control/tests/integration/test_end_to_end.py`

Behavior:
- Marker: `@pytest.mark.integration`. Skipped if `MC_INTEGRATION_TEST_URL` env var is unset.
- Fixture: spin up `wrangler dev` from `services/mission-control` in a subprocess; bootstrap via `POST /v1/bootstrap` (using the `MC_ADMIN_TOKEN` mechanism from MC's spec) to create a user + org + agent + connector + project.
- Tests cover the 7 scenarios from spec §"Integration tests".

Run:

```bash
MC_INTEGRATION_TEST_URL=http://localhost:8787 pytest tests/integration/ -m integration -v
```

Commit:

```
test(mc plugin): end-to-end integration tests (marker-gated)

Behind @pytest.mark.integration so the unit suite remains
docker/wrangler-free. Covers the seven scenarios from spec §Integration.
```

---

## Phase 11 — Branch wrap-up

After Task 23 lands:

1. Run the full unit suite from the plugin dir; verify green.
2. Run the MC test suite (`cd services/mission-control && pnpm test`); verify green (Phase 0 tasks did NOT touch other MC behaviour beyond pagination + spec).
3. Run the hermes upstream tests (`cd services/hermes/_source && python -m pytest tests/test_kanban_db.py -v`); verify green (Phase 0 task 3 added the helper).
4. Run `services/hermes/build.test.sh` (locally where the orb mount is available); verify green.
5. Move the spec + plan(s) into `docs/plans/implemented/` per repo convention.
6. Open PR against `main` from `feat/mc-plugin`.

---

## Self-review checklist (perform after writing all code, before opening PR)

- [ ] Every requirement in spec rev 3 has a corresponding task in this plan (cross-reference each section header).
- [ ] No `# TODO` or `# FIXME` markers in committed code.
- [ ] Every function in the plugin has a docstring explaining its purpose (one sentence is fine).
- [ ] No `from X import *`.
- [ ] All public functions take their dependencies explicitly (no module-level singletons for kanban/links conns — those are passed in).
- [ ] `register(ctx)` is a no-op when `HERMES_MC_URL` is unset (verified by `test_loop_guard.py`).
- [ ] No raw `ctx.pool.*` / `masterClient(...)` in any code — wait, that's the MC spec's rule, not ours. Our equivalent: no direct `os.environ` reads outside `config.py`; no direct `httpx` calls outside `client.py`; no direct `sqlite3` outside `links_db.py` (+ inside test fixtures).
- [ ] All idempotency keys derive from local row ids (stable across restarts).
- [ ] All pulled comments are authored with the `mission-control:` prefix.
- [ ] All MC→local writes go through kanban_db helpers (no raw UPDATEs to kanban tables).
- [ ] `mc_apply_log` is fed by EVERY pull-apply call (via pre/post-MAX range).
- [ ] Tests for the plugin run in <30s on a laptop.
