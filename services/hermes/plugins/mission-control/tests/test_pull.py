"""Tests for pull.pull_once and pull_loop.

The MC client is fully mocked. Apply layer is also mocked so we test
pull-loop coordination (cursor advance, pagination drain, backoff,
auth-failed bailout) independently of event-handler correctness.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from mission_control import pull as mc_pull
from mission_control import links_db as ldb
from mission_control import config as cfg
from mission_control import client as mc_client


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
    c.events_list = AsyncMock()
    return c


# ── pull_once ─────────────────────────────────────────────────────


async def test_pull_once_advances_cursor_to_highest_seen(env, auth, links_conn, mock_client):
    mock_client.events_list.return_value = {
        "events": [
            {"id": 5, "kind": "task.created", "payload": {}},
            {"id": 7, "kind": "task.created", "payload": {}},
            {"id": 6, "kind": "comment.created", "payload": {}},  # out-of-order to test max
        ],
        "next_cursor": None,
    }
    with patch("mission_control.pull.apply.handle_one_event", new=AsyncMock()) as fake_apply:
        count = await mc_pull.pull_once(env, auth, links_conn, mock_client)
    assert count == 3
    assert ldb.get_cursor(links_conn, "events") == 7
    assert fake_apply.await_count == 3


async def test_pull_once_passes_connector_key(env, auth, links_conn, mock_client):
    mock_client.events_list.return_value = {"events": [], "next_cursor": None}
    with patch("mission_control.pull.apply.handle_one_event", new=AsyncMock()):
        await mc_pull.pull_once(env, auth, links_conn, mock_client)
    mock_client.events_list.assert_awaited_once()
    kwargs = mock_client.events_list.call_args.kwargs
    assert kwargs["connector_key"] == "mccnn_x"
    assert kwargs["kinds"] == "task,comment,external_ref"


async def test_pull_once_drains_within_window_pagination(env, auth, links_conn, mock_client):
    """When the server returns next_cursor non-null, we keep paging within
    this poll cycle until empty."""
    pages = [
        {"events": [{"id": 1, "kind": "task.created", "payload": {}}], "next_cursor": "p2"},
        {"events": [{"id": 2, "kind": "task.created", "payload": {}}], "next_cursor": "p3"},
        {"events": [{"id": 3, "kind": "task.created", "payload": {}}], "next_cursor": None},
    ]
    mock_client.events_list.side_effect = pages
    with patch("mission_control.pull.apply.handle_one_event", new=AsyncMock()) as fake_apply:
        count = await mc_pull.pull_once(env, auth, links_conn, mock_client)
    assert count == 3
    assert fake_apply.await_count == 3
    assert mock_client.events_list.await_count == 3
    assert ldb.get_cursor(links_conn, "events") == 3


async def test_pull_once_purges_old_apply_log_entries(env, auth, links_conn, mock_client):
    # Pre-populate apply-log with old + fresh entries
    old_ts = int(time.time() * 1000) - 25 * 3600 * 1000
    fresh_ts = int(time.time() * 1000) - 1000
    ldb.record_apply(links_conn, event_id=1, link_id="t", applied_at=old_ts)
    ldb.record_apply(links_conn, event_id=2, link_id="t", applied_at=fresh_ts)

    mock_client.events_list.return_value = {"events": [], "next_cursor": None}
    with patch("mission_control.pull.apply.handle_one_event", new=AsyncMock()):
        await mc_pull.pull_once(env, auth, links_conn, mock_client)

    assert not ldb.is_in_apply_log(links_conn, 1)
    assert ldb.is_in_apply_log(links_conn, 2)


async def test_pull_once_does_not_advance_cursor_when_apply_raises(env, auth, links_conn, mock_client):
    """If apply.handle_one_event raises (shouldn't normally — it catches
    its own exceptions — but defensive), the cursor must not advance
    past the failing event."""
    mock_client.events_list.return_value = {
        "events": [
            {"id": 5, "kind": "task.created", "payload": {}},
            {"id": 6, "kind": "task.created", "payload": {}},
        ],
        "next_cursor": None,
    }
    raising_apply = AsyncMock(side_effect=[None, RuntimeError("boom")])
    with patch("mission_control.pull.apply.handle_one_event", new=raising_apply):
        with pytest.raises(RuntimeError):
            await mc_pull.pull_once(env, auth, links_conn, mock_client)
    # Cursor never advanced (still 0). The pull loop's apply already wraps
    # in its own try/except, so this case shouldn't fire in practice, but
    # if it does we want a re-poll to retry the unapplied event.
    assert ldb.get_cursor(links_conn, "events") == 0


# ── pull_loop ─────────────────────────────────────────────────────


async def test_pull_loop_runs_pull_once_and_sleeps(env, auth, links_conn, mock_client):
    """Loop hits pull_once, sleeps the poll interval, then exits when
    stop event is set."""
    mock_client.events_list.return_value = {"events": [], "next_cursor": None}
    stop = asyncio.Event()

    async def stop_after_two(*a, **kw):
        if mock_client.events_list.await_count >= 2:
            stop.set()
        return {"events": [], "next_cursor": None}

    mock_client.events_list.side_effect = stop_after_two

    # Speed up the loop by reducing poll interval drastically for this test
    env.poll_interval_s = 2  # min allowed
    with patch("mission_control.pull.apply.handle_one_event", new=AsyncMock()):
        # Patch asyncio.sleep so test runs fast
        with patch("mission_control.pull.asyncio.sleep", new=AsyncMock()):
            await mc_pull.pull_loop(env, auth, links_conn, mock_client, stop)
    assert mock_client.events_list.await_count >= 2


async def test_pull_loop_backoff_on_transient_5xx(env, auth, links_conn, mock_client):
    """5xx response → loop logs warn + backs off + retries on next cycle."""
    transient = httpx.HTTPStatusError(
        "503", request=httpx.Request("GET", "https://x"),
        response=httpx.Response(503),
    )
    # First call: raise transient. Second call: succeed → break.
    stop = asyncio.Event()
    call_count = {"n": 0}

    async def side(*a, **kw):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise transient
        stop.set()
        return {"events": [], "next_cursor": None}

    mock_client.events_list.side_effect = side
    env.poll_interval_s = 2
    sleeps: list[float] = []

    async def fake_sleep(s):
        sleeps.append(s)

    with patch("mission_control.pull.apply.handle_one_event", new=AsyncMock()):
        with patch("mission_control.pull.asyncio.sleep", new=fake_sleep):
            await mc_pull.pull_loop(env, auth, links_conn, mock_client, stop)
    assert call_count["n"] >= 2
    # At least one sleep should be a backoff delay (>= 0.1)
    assert any(s >= 0.1 for s in sleeps)


async def test_pull_loop_stops_on_auth_failed(env, auth, links_conn, mock_client):
    """AuthFailed → loop logs ERROR + sets status + returns (does NOT
    retry forever)."""
    mock_client.events_list.side_effect = mc_client.AuthFailed("401")
    stop = asyncio.Event()
    with patch("mission_control.pull.apply.handle_one_event", new=AsyncMock()):
        with patch("mission_control.pull.asyncio.sleep", new=AsyncMock()):
            # Loop must return on its own (not via stop event)
            await asyncio.wait_for(
                mc_pull.pull_loop(env, auth, links_conn, mock_client, stop),
                timeout=2.0,
            )
    status = mc_pull.get_pull_status()
    assert status.get("status") == "auth_failed"


def test_get_pull_status_returns_dict():
    s = mc_pull.get_pull_status()
    assert isinstance(s, dict)
