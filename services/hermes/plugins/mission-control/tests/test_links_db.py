"""Tests for the plugin-owned links_db.

Pure SQLite CRUD — no network, no MC, no kanban_db. The schema is
mc_links + mc_comment_links + mc_apply_log + mc_cursors.
"""
from __future__ import annotations

import time
import pytest

from mission_control import links_db as ldb


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "links.db"
    conn = ldb.connect(str(path))
    yield conn
    conn.close()


def test_schema_creates_all_tables(db):
    tables = {row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert {"mc_links", "mc_comment_links", "mc_apply_log", "mc_cursors"} <= tables


def test_schema_is_idempotent_on_reopen(tmp_path):
    path = tmp_path / "links.db"
    c1 = ldb.connect(str(path)); c1.close()
    c2 = ldb.connect(str(path))  # re-opening should not error
    tables = {row[0] for row in c2.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "mc_links" in tables


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
    assert link.source == "pulled"


def test_get_link_returns_none_when_missing(db):
    assert ldb.get_link(db, "nope") is None


def test_get_link_by_mc_task_id(db):
    ldb.insert_link(db, local_task_id="t_abc", mc_task_id="t_xyz",
                   mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                   source="pulled", local_status="ready", last_pulled_at=0)
    link = ldb.get_link_by_mc(db, "t_xyz")
    assert link is not None and link.local_task_id == "t_abc"
    assert ldb.get_link_by_mc(db, "nope") is None


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


def test_list_dirty_links(db):
    ldb.insert_link(db, local_task_id="t_a", mc_task_id="t_mc_a",
                   mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                   source="pulled", local_status="ready", last_pulled_at=0)
    ldb.insert_link(db, local_task_id="t_b", mc_task_id="t_mc_b",
                   mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                   source="pulled", local_status="ready", last_pulled_at=0)
    ldb.update_link_state(db, "t_a", push_dirty=1)
    dirty = ldb.list_dirty_links(db)
    assert [l.local_task_id for l in dirty] == ["t_a"]


def test_cursor_roundtrip(db):
    assert ldb.get_cursor(db, "events") == 0
    assert ldb.get_cursor(db, "kanban_events") == 0
    ldb.set_cursor(db, "events", 12345)
    assert ldb.get_cursor(db, "events") == 12345
    ldb.set_cursor(db, "events", 12346)  # update existing
    assert ldb.get_cursor(db, "events") == 12346
    # Other cursor key unaffected
    assert ldb.get_cursor(db, "kanban_events") == 0


def test_comment_link_dedup(db):
    ldb.insert_comment_link(db, local_comment_id=1, mc_comment_id="cmt_1",
                           local_task_id="t_abc", source="pulled")
    assert ldb.comment_has_local(db, 1) is True
    assert ldb.comment_has_mc(db, "cmt_1") is True
    assert ldb.comment_has_local(db, 999) is False
    assert ldb.comment_has_mc(db, "cmt_999") is False


def test_comment_link_double_insert_is_ignored(db):
    ldb.insert_comment_link(db, local_comment_id=1, mc_comment_id="cmt_1",
                           local_task_id="t_abc", source="pulled")
    # Second insert with same local_comment_id (PK) should not raise
    ldb.insert_comment_link(db, local_comment_id=1, mc_comment_id="cmt_1",
                           local_task_id="t_abc", source="pulled")


def test_apply_log_record_and_query(db):
    ldb.record_apply(db, event_id=42, link_id="t_abc")
    ldb.record_apply(db, event_id=43, link_id="t_abc")
    assert ldb.is_in_apply_log(db, 42) is True
    assert ldb.is_in_apply_log(db, 43) is True
    assert ldb.is_in_apply_log(db, 44) is False


def test_apply_log_record_is_idempotent(db):
    ldb.record_apply(db, event_id=42, link_id="t_abc")
    ldb.record_apply(db, event_id=42, link_id="t_abc")  # Should not raise
    assert ldb.is_in_apply_log(db, 42) is True


def test_apply_log_purge_old_entries(db):
    old_ts = int(time.time() * 1000) - 25 * 3600 * 1000  # 25h ago
    fresh_ts = int(time.time() * 1000) - 1000  # 1s ago
    ldb.record_apply(db, event_id=1, link_id="t_a", applied_at=old_ts)
    ldb.record_apply(db, event_id=2, link_id="t_a", applied_at=fresh_ts)
    deleted = ldb.purge_apply_log(db, older_than_ms=24 * 3600 * 1000)
    assert deleted == 1
    assert ldb.is_in_apply_log(db, 1) is False
    assert ldb.is_in_apply_log(db, 2) is True


def test_update_link_state_partial_fields(db):
    ldb.insert_link(db, local_task_id="t_abc", mc_task_id="t_xyz",
                   mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                   source="pulled", local_status="ready", last_pulled_at=0)
    ldb.update_link_state(db, "t_abc", local_status="done",
                         last_pulled_at=1000, last_terminal_state="completed")
    link = ldb.get_link(db, "t_abc")
    assert link.local_status == "done"
    assert link.last_terminal_state == "completed"
    assert link.last_pulled_at == 1000


def test_update_link_state_no_op_when_no_kwargs(db):
    ldb.insert_link(db, local_task_id="t_abc", mc_task_id="t_xyz",
                   mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                   source="pulled", local_status="ready", last_pulled_at=0)
    ldb.update_link_state(db, "t_abc")  # no fields → no-op
    link = ldb.get_link(db, "t_abc")
    assert link.local_status == "ready"


def test_delete_link(db):
    ldb.insert_link(db, local_task_id="t_abc", mc_task_id="t_xyz",
                   mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                   source="pulled", local_status="ready", last_pulled_at=0)
    ldb.delete_link(db, "t_abc")
    assert ldb.get_link(db, "t_abc") is None
