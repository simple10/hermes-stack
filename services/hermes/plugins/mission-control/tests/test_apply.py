"""Tests for apply.handle_one_event — MC event-kind dispatch.

Uses a real in-memory-ish kanban_db (tmp_path-backed) so the
pre/post-MAX apply-log capture actually exercises the SQL path,
and an in-memory links_db. The MC client is mocked.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from mission_control import apply as mc_apply
from mission_control import config as cfg
from mission_control import links_db as ldb


# ── Fixtures ────────────────────────────────────────────────────────

@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    """Isolated HERMES_HOME with an empty kanban DB."""
    import hermes_cli.kanban_db as kb
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


@pytest.fixture
def env(tmp_path, kanban_home):
    """Plugin Env pointing at the default board + links.db in tmp_path."""
    return cfg.Env(
        url="https://mc.example.com",
        user_pat=None,
        agent_name="vm-test",
        board=None,      # use default board
        poll_interval_s=10,
        default_project_slug=None,
        debug=False,
    )


@pytest.fixture
def auth():
    return cfg.Auth(
        url="https://mc.example.com",
        org_id="org_1",
        agent_id="agt_self",
        agent_key="mcagt_x",
        connector_id="cnn_1",
        connector_key="mccnn_x",
        registered_at=1,
    )


@pytest.fixture
def links_conn(tmp_path):
    """An isolated in-tmp links.db."""
    return ldb.connect(str(tmp_path / "links.db"))


@pytest.fixture
def mock_client():
    """AsyncMock for the MC HTTP client."""
    c = MagicMock()
    c.tasks_get = AsyncMock()
    c.external_ref_create = AsyncMock()
    return c


# ── helpers ─────────────────────────────────────────────────────────


def _ev(kind, *, resource_id="t_mc_abc", payload=None, **overrides):
    base = {
        "id": 1,
        "org_id": "org_1",
        "resource_type": "task" if kind.startswith("task.") else "comment",
        "resource_id": resource_id,
        "kind": kind,
        "actor_type": "user",
        "actor_id": "usr_1",
        "payload": payload or {},
        "created_at": 1000,
    }
    base.update(overrides)
    return base


# ── task.created ────────────────────────────────────────────────────


async def test_task_created_for_our_agent_creates_local_row(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    ev = _ev("task.created", resource_id="t_mc_1", payload={"task": {
        "id": "t_mc_1", "agent_id": "agt_self", "project_id": "prj_1",
        "title": "T", "body": "B", "status": "ready", "updated_at": 1234,
    }})
    await mc_apply.handle_one_event(ev, env, auth, mock_client, ldb_conn=links_conn)

    link = ldb.get_link_by_mc(links_conn, "t_mc_1")
    assert link is not None
    assert link.source == "pulled"
    assert link.local_status == "ready"
    assert link.mc_org_id == "org_1"
    assert link.mc_project_id == "prj_1"
    assert link.last_pulled_at == 1234

    # The local kanban task exists
    with kb.connect() as kconn:
        task = kb.get_task(kconn, link.local_task_id)
        assert task is not None
        assert task.title == "T"
        assert task.assignee == "agt_self"

    # external_ref POSTed to MC with agent key
    mock_client.external_ref_create.assert_awaited_once()
    args, kwargs = mock_client.external_ref_create.call_args
    assert kwargs["agent_key"] == "mcagt_x"
    assert kwargs["source_kind"] == "hermes"
    assert kwargs["source_id"] == "agt_self"
    assert kwargs["external_id"] == link.local_task_id
    assert kwargs["resource_type"] == "task"
    assert kwargs["resource_id"] == "t_mc_1"


async def test_task_created_for_other_agent_is_skipped(env, auth, links_conn, mock_client):
    ev = _ev("task.created", resource_id="t_mc_2", payload={"task": {
        "id": "t_mc_2", "agent_id": "agt_someone_else", "project_id": "p",
        "title": "T", "status": "ready", "updated_at": 1234,
    }})
    await mc_apply.handle_one_event(ev, env, auth, mock_client, ldb_conn=links_conn)
    assert ldb.get_link_by_mc(links_conn, "t_mc_2") is None
    mock_client.external_ref_create.assert_not_called()


async def test_task_created_with_no_agent_is_skipped(env, auth, links_conn, mock_client):
    """Unassigned tasks (pending) don't get pulled per the plan."""
    ev = _ev("task.created", resource_id="t_mc_3", payload={"task": {
        "id": "t_mc_3", "agent_id": None, "project_id": "p",
        "title": "T", "status": "pending", "updated_at": 1234,
    }})
    await mc_apply.handle_one_event(ev, env, auth, mock_client, ldb_conn=links_conn)
    assert ldb.get_link_by_mc(links_conn, "t_mc_3") is None


async def test_task_created_when_link_already_exists_is_idempotent(env, auth, links_conn, mock_client, kanban_home):
    """Re-receiving the same task.created (e.g. on cursor replay) is a no-op."""
    import hermes_cli.kanban_db as kb
    ev = _ev("task.created", resource_id="t_mc_4", payload={"task": {
        "id": "t_mc_4", "agent_id": "agt_self", "project_id": "p",
        "title": "T", "status": "ready", "updated_at": 1234,
    }})
    await mc_apply.handle_one_event(ev, env, auth, mock_client, ldb_conn=links_conn)
    # Re-deliver
    await mc_apply.handle_one_event(ev, env, auth, mock_client, ldb_conn=links_conn)

    # Still one link
    link = ldb.get_link_by_mc(links_conn, "t_mc_4")
    assert link is not None
    # external_ref_create called only once (the first time)
    assert mock_client.external_ref_create.await_count == 1


# ── task.assigned ───────────────────────────────────────────────────


async def test_task_assigned_to_us_hydrates_and_creates(env, auth, links_conn, mock_client, kanban_home):
    mock_client.tasks_get.return_value = {"task": {
        "id": "t_mc_assigned", "agent_id": "agt_self", "project_id": "prj_5",
        "title": "Hydrated", "status": "ready", "updated_at": 2000,
    }}
    ev = _ev("task.assigned", resource_id="t_mc_assigned", payload={
        "from": None, "to": "agt_self",
    })
    await mc_apply.handle_one_event(ev, env, auth, mock_client, ldb_conn=links_conn)
    mock_client.tasks_get.assert_awaited_once()
    link = ldb.get_link_by_mc(links_conn, "t_mc_assigned")
    assert link is not None
    assert link.local_status == "ready"


async def test_task_assigned_to_other_agent_is_skipped(env, auth, links_conn, mock_client):
    ev = _ev("task.assigned", resource_id="t_mc_x", payload={
        "from": "agt_self", "to": "agt_other",
    })
    await mc_apply.handle_one_event(ev, env, auth, mock_client, ldb_conn=links_conn)
    mock_client.tasks_get.assert_not_called()


# ── task.status_changed ─────────────────────────────────────────────


async def test_status_changed_to_blocked_calls_block_task(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    # Pre-seed: create a local task and link via a task.created event
    create_ev = _ev("task.created", resource_id="t_mc_blk", payload={"task": {
        "id": "t_mc_blk", "agent_id": "agt_self", "project_id": "p",
        "title": "T", "status": "ready", "updated_at": 100,
    }})
    await mc_apply.handle_one_event(create_ev, env, auth, mock_client, ldb_conn=links_conn)
    link = ldb.get_link_by_mc(links_conn, "t_mc_blk")
    assert link is not None

    # Transition the task to 'running' so block_task accepts it.
    with kb.connect() as kconn:
        kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (link.local_task_id,))

    # Now fire status_changed to blocked
    blk_ev = _ev("task.status_changed", resource_id="t_mc_blk", payload={
        "from": "in_progress", "to": "blocked", "reason": "needs review",
    })
    blk_ev["id"] = 999
    # Add to in-memory ev so updated_at is reflected
    blk_ev["payload"]["task"] = {"updated_at": 2000, "metadata": {"block_reason": "needs review"}}
    await mc_apply.handle_one_event(blk_ev, env, auth, mock_client, ldb_conn=links_conn)

    # Local task is blocked
    with kb.connect() as kconn:
        task = kb.get_task(kconn, link.local_task_id)
        assert task.status == "blocked"

    # mc_apply_log captured the blocked event row id(s)
    # At least one row should have been recorded
    with kb.connect() as kconn:
        ev_ids = [r[0] for r in kconn.execute(
            "SELECT id FROM task_events WHERE task_id=? AND kind='blocked'",
            (link.local_task_id,)).fetchall()]
    for eid in ev_ids:
        assert ldb.is_in_apply_log(links_conn, eid)


async def test_status_changed_to_completed_calls_complete_task(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    create_ev = _ev("task.created", resource_id="t_mc_done", payload={"task": {
        "id": "t_mc_done", "agent_id": "agt_self", "project_id": "p",
        "title": "T", "status": "ready", "updated_at": 100,
    }})
    await mc_apply.handle_one_event(create_ev, env, auth, mock_client, ldb_conn=links_conn)
    link = ldb.get_link_by_mc(links_conn, "t_mc_done")

    done_ev = _ev("task.status_changed", resource_id="t_mc_done", payload={
        "from": "ready", "to": "completed",
        "task": {"updated_at": 2000, "metadata": {}},
    })
    done_ev["id"] = 1000
    await mc_apply.handle_one_event(done_ev, env, auth, mock_client, ldb_conn=links_conn)

    with kb.connect() as kconn:
        task = kb.get_task(kconn, link.local_task_id)
        assert task.status == "done"

    refreshed = ldb.get_link_by_mc(links_conn, "t_mc_done")
    assert refreshed.last_terminal_state == "completed"


async def test_status_changed_when_no_link_is_skipped(env, auth, links_conn, mock_client):
    """Status events for tasks we never pulled are ignored."""
    ev = _ev("task.status_changed", resource_id="t_mc_unknown", payload={
        "from": "ready", "to": "in_progress",
    })
    await mc_apply.handle_one_event(ev, env, auth, mock_client, ldb_conn=links_conn)
    # No crash; nothing to do


# ── task.deleted ────────────────────────────────────────────────────


async def test_task_deleted_archives_local(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    create_ev = _ev("task.created", resource_id="t_mc_del", payload={"task": {
        "id": "t_mc_del", "agent_id": "agt_self", "project_id": "p",
        "title": "T", "status": "ready", "updated_at": 100,
    }})
    await mc_apply.handle_one_event(create_ev, env, auth, mock_client, ldb_conn=links_conn)
    link = ldb.get_link_by_mc(links_conn, "t_mc_del")

    del_ev = _ev("task.deleted", resource_id="t_mc_del", payload={
        "task": {"updated_at": 2000},
    })
    del_ev["id"] = 1234
    await mc_apply.handle_one_event(del_ev, env, auth, mock_client, ldb_conn=links_conn)

    with kb.connect() as kconn:
        task = kb.get_task(kconn, link.local_task_id)
        assert task.status == "archived"

    refreshed = ldb.get_link_by_mc(links_conn, "t_mc_del")
    assert refreshed.last_terminal_state == "cancelled"


# ── comment.created ─────────────────────────────────────────────────


async def test_comment_created_adds_local_comment(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    create_ev = _ev("task.created", resource_id="t_mc_cmt", payload={"task": {
        "id": "t_mc_cmt", "agent_id": "agt_self", "project_id": "p",
        "title": "T", "status": "ready", "updated_at": 100,
    }})
    await mc_apply.handle_one_event(create_ev, env, auth, mock_client, ldb_conn=links_conn)
    link = ldb.get_link_by_mc(links_conn, "t_mc_cmt")

    cmt_ev = _ev("comment.created", resource_id="cmt_abc", payload={"comment": {
        "id": "cmt_abc",
        "task_id": "t_mc_cmt",
        "body": "hello from notion",
        "author_type": "user",
        "author_id": "usr_42",
        "created_at": 5000,
    }})
    cmt_ev["id"] = 5
    await mc_apply.handle_one_event(cmt_ev, env, auth, mock_client, ldb_conn=links_conn)

    with kb.connect() as kconn:
        comments = kb.list_comments(kconn, link.local_task_id)
        assert len(comments) == 1
        assert "hello from notion" in comments[0].body
        # Author is prefixed
        assert comments[0].author.startswith("mission-control:user:usr_42")

    # mc_comment_links populated
    assert ldb.comment_has_mc(links_conn, "cmt_abc")


async def test_comment_created_dedupes_on_resend(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    # Set up
    create_ev = _ev("task.created", resource_id="t_mc_dd", payload={"task": {
        "id": "t_mc_dd", "agent_id": "agt_self", "project_id": "p",
        "title": "T", "status": "ready", "updated_at": 100,
    }})
    await mc_apply.handle_one_event(create_ev, env, auth, mock_client, ldb_conn=links_conn)
    link = ldb.get_link_by_mc(links_conn, "t_mc_dd")

    cmt_ev = _ev("comment.created", resource_id="cmt_dd", payload={"comment": {
        "id": "cmt_dd", "task_id": "t_mc_dd", "body": "a",
        "author_type": "user", "author_id": "u",
        "created_at": 5000,
    }})
    await mc_apply.handle_one_event(cmt_ev, env, auth, mock_client, ldb_conn=links_conn)
    await mc_apply.handle_one_event(cmt_ev, env, auth, mock_client, ldb_conn=links_conn)  # re-deliver

    with kb.connect() as kconn:
        comments = kb.list_comments(kconn, link.local_task_id)
    assert len(comments) == 1


async def test_comment_on_blocked_task_auto_unblocks(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    # Set up the link and put it in blocked state
    create_ev = _ev("task.created", resource_id="t_mc_blkcmt", payload={"task": {
        "id": "t_mc_blkcmt", "agent_id": "agt_self", "project_id": "p",
        "title": "T", "status": "ready", "updated_at": 100,
    }})
    await mc_apply.handle_one_event(create_ev, env, auth, mock_client, ldb_conn=links_conn)
    link = ldb.get_link_by_mc(links_conn, "t_mc_blkcmt")

    # Force local to blocked via the proper helper path
    with kb.connect() as kconn:
        kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (link.local_task_id,))
    blk_ev = _ev("task.status_changed", resource_id="t_mc_blkcmt", payload={
        "from": "in_progress", "to": "blocked",
        "task": {"updated_at": 200, "metadata": {"block_reason": "wait"}},
    })
    await mc_apply.handle_one_event(blk_ev, env, auth, mock_client, ldb_conn=links_conn)

    # Verify it's blocked locally and the link knows
    with kb.connect() as kconn:
        assert kb.get_task(kconn, link.local_task_id).status == "blocked"
    assert ldb.get_link_by_mc(links_conn, "t_mc_blkcmt").local_status == "blocked"

    # Now comment arrives
    cmt_ev = _ev("comment.created", resource_id="cmt_unblk", payload={"comment": {
        "id": "cmt_unblk", "task_id": "t_mc_blkcmt", "body": "please continue",
        "author_type": "user", "author_id": "u",
        "created_at": 5000,
    }})
    await mc_apply.handle_one_event(cmt_ev, env, auth, mock_client, ldb_conn=links_conn)

    # Task is now unblocked (status='ready' per kanban_db.unblock_task semantics)
    with kb.connect() as kconn:
        assert kb.get_task(kconn, link.local_task_id).status == "ready"

    # Link's local_status reflects the unblock
    refreshed = ldb.get_link_by_mc(links_conn, "t_mc_blkcmt")
    assert refreshed.local_status == "ready"


async def test_comment_on_running_task_does_not_unblock(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    create_ev = _ev("task.created", resource_id="t_mc_runcmt", payload={"task": {
        "id": "t_mc_runcmt", "agent_id": "agt_self", "project_id": "p",
        "title": "T", "status": "ready", "updated_at": 100,
    }})
    await mc_apply.handle_one_event(create_ev, env, auth, mock_client, ldb_conn=links_conn)
    link = ldb.get_link_by_mc(links_conn, "t_mc_runcmt")

    # Force local to running
    with kb.connect() as kconn:
        kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (link.local_task_id,))
    # And update the link denorm
    ldb.update_link_state(links_conn, link.local_task_id, local_status="running")

    cmt_ev = _ev("comment.created", resource_id="cmt_nounblk", payload={"comment": {
        "id": "cmt_nounblk", "task_id": "t_mc_runcmt", "body": "FYI",
        "author_type": "user", "author_id": "u",
        "created_at": 5000,
    }})
    await mc_apply.handle_one_event(cmt_ev, env, auth, mock_client, ldb_conn=links_conn)

    with kb.connect() as kconn:
        assert kb.get_task(kconn, link.local_task_id).status == "running"


async def test_comment_on_unlinked_task_is_skipped(env, auth, links_conn, mock_client):
    cmt_ev = _ev("comment.created", resource_id="cmt_orphan", payload={"comment": {
        "id": "cmt_orphan", "task_id": "t_mc_unknown", "body": "hi",
        "author_type": "user", "author_id": "u",
        "created_at": 5000,
    }})
    await mc_apply.handle_one_event(cmt_ev, env, auth, mock_client, ldb_conn=links_conn)
    # No crash


# ── unknown / v1-skipped kinds ─────────────────────────────────────


@pytest.mark.parametrize("kind", [
    "task.updated",
    "comment.deleted",
    "external_ref.added",
    "external_ref.removed",
    "agent.created",
    "connector.created",
    "project.created",
    "some.future.kind",
])
async def test_v1_skipped_kinds_are_noop(env, auth, links_conn, mock_client, kind):
    ev = _ev(kind, payload={})
    # Should not raise
    await mc_apply.handle_one_event(ev, env, auth, mock_client, ldb_conn=links_conn)
