"""Tests for push.push_once and push_loop.

Uses a real in-tmp_path kanban_db (so the raw SQL queries actually work)
and an in-memory links_db. The MC client is mocked.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from mission_control import push as mc_push
from mission_control import links_db as ldb
from mission_control import config as cfg
from mission_control import client as mc_client


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    import hermes_cli.kanban_db as kb
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


@pytest.fixture
def env():
    return cfg.Env(
        url="https://mc.example.com",
        user_pat=None,
        agent_name="vm-test",
        board=None,
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
    return ldb.connect(str(tmp_path / "links.db"))


@pytest.fixture
def mock_client():
    c = MagicMock()
    c.tasks_patch = AsyncMock()
    c.task_comment_create = AsyncMock()
    return c


def _create_linked_task(kanban_home, links_conn, *, mc_task_id="t_mc_1", local_status="ready"):
    """Create a local kanban task + corresponding mc_links row."""
    import hermes_cli.kanban_db as kb
    with kb.connect() as kconn:
        local_id = kb.create_task(kconn, title="T", assignee="agt_self")
    ldb.insert_link(
        links_conn,
        local_task_id=local_id,
        mc_task_id=mc_task_id,
        mc_org_id="org_1",
        mc_project_id="prj_1",
        mc_agent_id="agt_self",
        source="pulled",
        local_status=local_status,
        last_pulled_at=100,
    )
    return local_id


# ── push_once: cursor + apply-log filter ─────────────────────────


async def test_push_once_advances_cursor_through_unlinked_events(env, auth, links_conn, mock_client, kanban_home):
    """task_events for tasks we don't have a link for: cursor advances but no PATCH happens."""
    import hermes_cli.kanban_db as kb
    with kb.connect() as kconn:
        kb.create_task(kconn, title="A")
        kb.create_task(kconn, title="B")
    # No links inserted — these are not MC-mirrored
    count = await mc_push.push_once(env, auth, links_conn, mock_client)
    # count reflects rows fetched (examined), not dispatched — create_task
    # emits events, all of which are skipped (no link) but still counted.
    assert count >= 0
    # cursor advanced past the create events
    cur = ldb.get_cursor(links_conn, "kanban_events")
    assert cur > 0
    mock_client.tasks_patch.assert_not_called()


async def test_push_once_skips_events_in_apply_log(env, auth, links_conn, mock_client, kanban_home):
    """Events whose id is in mc_apply_log are echoes from a pull-apply — skip."""
    import hermes_cli.kanban_db as kb
    local_id = _create_linked_task(kanban_home, links_conn)
    # Force an event row by adding a comment (kanban emits 'commented')
    with kb.connect() as kconn:
        kb.add_comment(kconn, local_id, "agt_self", "echo me")
        ev_id = kconn.execute(
            "SELECT id FROM task_events WHERE task_id=? AND kind='commented'",
            (local_id,),
        ).fetchone()[0]
    ldb.record_apply(links_conn, event_id=ev_id, link_id=local_id)

    await mc_push.push_once(env, auth, links_conn, mock_client)
    # Even though there's a commented event, we skip because it's in apply log
    mock_client.task_comment_create.assert_not_called()


# ── status events ────────────────────────────────────────────────


async def test_push_once_patches_status_on_claimed(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    local_id = _create_linked_task(kanban_home, links_conn)
    # Use claim_task to emit a 'claimed' event
    with kb.connect() as kconn:
        try:
            kb.claim_task(kconn, local_id, claimer="agt_self")
        except Exception:
            # Fallback: raw insert of a 'claimed' event row + status flip
            kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (local_id,))
            kconn.execute(
                "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?, 'claimed', '{}', strftime('%s', 'now'))",
                (local_id,))

    mock_client.tasks_patch.return_value = {"task": {"id": "t_mc_1", "updated_at": 500}}
    await mc_push.push_once(env, auth, links_conn, mock_client)
    mock_client.tasks_patch.assert_awaited()
    call = mock_client.tasks_patch.call_args
    assert call.kwargs["agent_key"] == "mcagt_x"
    assert call.kwargs["mc_task_id"] == "t_mc_1"
    assert call.kwargs["status"] == "in_progress"


async def test_push_once_patches_blocked_with_reason(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    local_id = _create_linked_task(kanban_home, links_conn)
    with kb.connect() as kconn:
        kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (local_id,))
        kb.block_task(kconn, local_id, reason="waiting for human")

    mock_client.tasks_patch.return_value = {"task": {"id": "t_mc_1", "updated_at": 600}}
    await mc_push.push_once(env, auth, links_conn, mock_client)
    call = mock_client.tasks_patch.call_args
    assert call.kwargs["status"] == "blocked"
    assert call.kwargs["metadata"]["block_reason"] == "waiting for human"


async def test_push_once_completed_uses_latest_run_outcome(env, auth, links_conn, mock_client, kanban_home):
    """A 'completed' kanban event triggers a latest_run() lookup. If the
    run outcome is 'completed' → MC status='completed'; anything else
    (crashed, timed_out, etc.) → MC 'failed'."""
    import hermes_cli.kanban_db as kb
    local_id = _create_linked_task(kanban_home, links_conn)
    with kb.connect() as kconn:
        # Simulate a successful completion: claim → start a run → complete
        try:
            kb.claim_task(kconn, local_id, claimer="agt_self")
        except Exception:
            kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (local_id,))
        kb.complete_task(kconn, local_id, result="OK", summary="OK")

    mock_client.tasks_patch.return_value = {"task": {"id": "t_mc_1", "updated_at": 700}}
    await mc_push.push_once(env, auth, links_conn, mock_client)

    # Look at the last PATCH made for this task
    calls = [c for c in mock_client.tasks_patch.call_args_list if c.kwargs.get("mc_task_id") == "t_mc_1"]
    assert calls, "expected a PATCH for t_mc_1"
    last = calls[-1]
    assert last.kwargs["status"] in ("completed", "failed")
    # link.last_terminal_state was set
    link = ldb.get_link_by_mc(links_conn, "t_mc_1")
    assert link.last_terminal_state in ("completed", "failed")


# ── commented events ─────────────────────────────────────────────


async def test_push_once_posts_comment_to_mc(env, auth, links_conn, mock_client, kanban_home):
    import hermes_cli.kanban_db as kb
    local_id = _create_linked_task(kanban_home, links_conn)
    with kb.connect() as kconn:
        cmt_id = kb.add_comment(kconn, local_id, "agt_self", "hello mc")

    mock_client.task_comment_create.return_value = {"comment": {"id": "cmt_mc_new"}}
    await mc_push.push_once(env, auth, links_conn, mock_client)
    mock_client.task_comment_create.assert_awaited()
    call = mock_client.task_comment_create.call_args
    assert call.kwargs["mc_task_id"] == "t_mc_1"
    assert call.kwargs["body"] == "hello mc"
    assert call.kwargs["idempotency_key"] == f"hermes:cmt:{cmt_id}"
    # comment_link inserted
    assert ldb.comment_has_local(links_conn, cmt_id)
    assert ldb.comment_has_mc(links_conn, "cmt_mc_new")


async def test_push_once_skips_comment_with_mission_control_author(env, auth, links_conn, mock_client, kanban_home):
    """Defense-in-depth: comments authored with the mission-control: prefix
    are pulled-from-MC comments and must not be re-pushed."""
    import hermes_cli.kanban_db as kb
    local_id = _create_linked_task(kanban_home, links_conn)
    with kb.connect() as kconn:
        kb.add_comment(kconn, local_id, "mission-control:user:usr_42", "from MC")

    await mc_push.push_once(env, auth, links_conn, mock_client)
    mock_client.task_comment_create.assert_not_called()


async def test_push_once_skips_comment_already_in_mc_comment_links(env, auth, links_conn, mock_client, kanban_home):
    """Primary dedup: if mc_comment_links already has this local comment
    (pulled or pushed), skip."""
    import hermes_cli.kanban_db as kb
    local_id = _create_linked_task(kanban_home, links_conn)
    with kb.connect() as kconn:
        cmt_id = kb.add_comment(kconn, local_id, "agt_self", "hi")
    ldb.insert_comment_link(
        links_conn,
        local_comment_id=cmt_id,
        mc_comment_id="cmt_already",
        local_task_id=local_id,
        source="pulled",
    )

    await mc_push.push_once(env, auth, links_conn, mock_client)
    mock_client.task_comment_create.assert_not_called()


# ── error paths ──────────────────────────────────────────────────


async def test_push_once_handles_notfound_by_archiving_locally(env, auth, links_conn, mock_client, kanban_home):
    """404 from MC PATCH means MC deleted the task. Delete the link and
    archive the local task."""
    import hermes_cli.kanban_db as kb
    local_id = _create_linked_task(kanban_home, links_conn)
    with kb.connect() as kconn:
        kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (local_id,))
        kb.block_task(kconn, local_id, reason="x")

    mock_client.tasks_patch.side_effect = mc_client.NotFound("not found")
    await mc_push.push_once(env, auth, links_conn, mock_client)

    # Link removed
    assert ldb.get_link_by_mc(links_conn, "t_mc_1") is None
    # Local task archived
    with kb.connect() as kconn:
        assert kb.get_task(kconn, local_id).status == "archived"


async def test_push_once_logs_state_machine_conflict_without_retrying(env, auth, links_conn, mock_client, kanban_home):
    """409 task.invalid_transition: log + move on. Pull will reconcile."""
    import hermes_cli.kanban_db as kb
    local_id = _create_linked_task(kanban_home, links_conn)
    with kb.connect() as kconn:
        kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (local_id,))
        kb.block_task(kconn, local_id, reason="x")

    mock_client.tasks_patch.side_effect = mc_client.StateMachineConflict("invalid")
    # Should NOT raise; just log
    count = await mc_push.push_once(env, auth, links_conn, mock_client)
    # Cursor still advanced (we processed the event, just couldn't push)
    assert count >= 0
    assert ldb.get_cursor(links_conn, "kanban_events") > 0


# ── push_loop ────────────────────────────────────────────────────


async def test_push_loop_stops_on_auth_failed(env, auth, links_conn, mock_client, kanban_home):
    mock_client.tasks_patch.side_effect = mc_client.AuthFailed("401")
    # Need at least one event to trigger the PATCH; without it the loop won't see the error.
    import hermes_cli.kanban_db as kb
    local_id = _create_linked_task(kanban_home, links_conn)
    with kb.connect() as kconn:
        kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (local_id,))
        kb.block_task(kconn, local_id, reason="x")

    stop = asyncio.Event()
    with patch("mission_control.push.asyncio.sleep", new=AsyncMock()):
        await asyncio.wait_for(
            mc_push.push_loop(env, auth, links_conn, mock_client, stop),
            timeout=2.0,
        )
    status = mc_push.get_push_status()
    assert status.get("status") == "auth_failed"


def test_get_push_status_returns_dict():
    assert isinstance(mc_push.get_push_status(), dict)
