"""Tests for runtime.start/stop and the daemon-thread lifecycle.

We monkeypatch pull_loop / push_loop with fakes so the test runs
synchronously and quickly. The real client is constructed but never
makes HTTP calls (the fakes ignore it).
"""
from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from mission_control import runtime as rt
from mission_control import config as cfg


@pytest.fixture(autouse=True)
def reset_runtime():
    rt._reset_for_tests()
    yield
    rt._reset_for_tests()


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


def test_start_runs_loops_in_a_daemon_thread(env, auth, tmp_path):
    pull_calls = []
    push_calls = []

    async def fake_pull_loop(env, auth, ldb_conn, client, stop_event):
        while not stop_event.is_set():
            pull_calls.append(time.time())
            await asyncio.sleep(0.02)

    async def fake_push_loop(env, auth, ldb_conn, client, stop_event):
        while not stop_event.is_set():
            push_calls.append(time.time())
            await asyncio.sleep(0.02)

    with patch("mission_control.runtime.mc_pull.pull_loop", new=fake_pull_loop):
        with patch("mission_control.runtime.mc_push.push_loop", new=fake_push_loop):
            rt.start(env, auth, str(tmp_path / "links.db"))
            # Let the thread tick a few times
            time.sleep(0.2)
            status = rt.get_status()
            assert status["loops_running"] is True
            assert len(pull_calls) >= 2
            assert len(push_calls) >= 2

            rt.stop(join_timeout_s=2.0)
            time.sleep(0.05)
            assert rt.get_status()["loops_running"] is False


def test_start_is_idempotent(env, auth, tmp_path):
    started_threads: list[threading.Thread] = []

    async def fake_loop(env, auth, ldb_conn, client, stop_event):
        started_threads.append(threading.current_thread())
        await stop_event.wait()

    with patch("mission_control.runtime.mc_pull.pull_loop", new=fake_loop):
        with patch("mission_control.runtime.mc_push.push_loop", new=fake_loop):
            rt.start(env, auth, str(tmp_path / "links.db"))
            time.sleep(0.1)
            t1 = rt._thread

            rt.start(env, auth, str(tmp_path / "links.db"))  # no-op
            time.sleep(0.05)
            t2 = rt._thread

            assert t1 is t2  # same thread instance

            rt.stop(join_timeout_s=2.0)


def test_get_status_merges_pull_push_runtime(env, auth, tmp_path):
    async def fake_loop(env, auth, ldb_conn, client, stop_event):
        await stop_event.wait()

    with patch("mission_control.runtime.mc_pull.pull_loop", new=fake_loop):
        with patch("mission_control.runtime.mc_push.push_loop", new=fake_loop):
            rt.start(env, auth, str(tmp_path / "links.db"))
            time.sleep(0.1)
            s = rt.get_status()
            # Runtime-level fields
            assert "loops_running" in s
            assert "started_at" in s
            # Pull-level fields
            assert "pull_events_cursor" in s
            assert "pull_consecutive_errors" in s
            # Push-level fields
            assert "push_kanban_events_cursor" in s
            assert "push_consecutive_errors" in s
            rt.stop(join_timeout_s=2.0)


def test_get_status_when_not_started_returns_defaults():
    s = rt.get_status()
    assert s["loops_running"] is False
    assert s["started_at"] is None


def test_thread_crash_records_error(env, auth, tmp_path):
    async def fake_pull_loop(env, auth, ldb_conn, client, stop_event):
        raise RuntimeError("boom")

    async def fake_push_loop(env, auth, ldb_conn, client, stop_event):
        await stop_event.wait()

    with patch("mission_control.runtime.mc_pull.pull_loop", new=fake_pull_loop):
        with patch("mission_control.runtime.mc_push.push_loop", new=fake_push_loop):
            rt.start(env, auth, str(tmp_path / "links.db"))
            time.sleep(0.3)
            s = rt.get_status()
            assert s["loops_running"] is False
            assert s["last_thread_error"] is not None
            assert "boom" in s["last_thread_error"]
