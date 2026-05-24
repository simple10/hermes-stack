"""Tests for the dashboard plugin_api status endpoint."""
from __future__ import annotations

import json
import importlib.util
from pathlib import Path
from unittest.mock import patch

import pytest


@pytest.fixture
def plugin_api(tmp_path, monkeypatch):
    plugin_root = Path(__file__).resolve().parents[1]
    api_path = plugin_root / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("dashboard_plugin_api", api_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def auth_path(tmp_path):
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({
        "providers": {
            "mission_control": {
                "url": "https://mc.example.com",
                "org_id": "org_1",
                "agent_id": "agt_self",
                "agent_key": "mcagt_x",
                "connector_id": "cnn_1",
                "connector_key": "mccnn_x",
                "registered_at": 1,
            }
        }
    }))
    return p


@pytest.fixture
def links_db_path(tmp_path):
    return tmp_path / "links.db"


@pytest.fixture(autouse=True)
def reset_cache():
    from mission_control import config as cfg
    cfg._reset_cache_for_tests()


def test_unregistered_returns_registered_false(plugin_api, tmp_path, monkeypatch):
    monkeypatch.delenv("HERMES_MC_URL", raising=False)
    result = plugin_api._build_status(
        auth_path=tmp_path / "no-auth.json",
        links_db_path=tmp_path / "no-links.db",
    )
    assert result["registered"] is False
    assert result["org_id"] is None
    assert result["agent_id"] is None
    assert result["loops_running"] is False


def test_url_from_env_when_no_auth(plugin_api, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc-env.example.com")
    result = plugin_api._build_status(
        auth_path=tmp_path / "no-auth.json",
        links_db_path=tmp_path / "no-links.db",
    )
    assert result["url"] == "https://mc-env.example.com"
    assert result["registered"] is False


def test_registered_returns_auth_fields(plugin_api, auth_path, links_db_path):
    result = plugin_api._build_status(
        auth_path=auth_path,
        links_db_path=links_db_path,
    )
    assert result["registered"] is True
    assert result["url"] == "https://mc.example.com"
    assert result["org_id"] == "org_1"
    assert result["agent_id"] == "agt_self"
    assert result["connector_id"] == "cnn_1"


def test_includes_runtime_status_fields(plugin_api, auth_path, links_db_path):
    result = plugin_api._build_status(
        auth_path=auth_path,
        links_db_path=links_db_path,
    )
    for f in (
        "loops_running", "status", "events_cursor", "kanban_events_cursor",
        "last_pull_ok_at", "last_push_ok_at",
        "consecutive_pull_errors", "consecutive_push_errors",
        "last_pull_error", "last_push_error",
        "started_at", "last_thread_error",
        "links_total", "links_dirty", "comments_linked",
    ):
        assert f in result, f"missing field: {f}"


def test_reads_link_counts_from_db(plugin_api, auth_path, links_db_path):
    from mission_control import links_db as ldb
    conn = ldb.connect(str(links_db_path))
    try:
        for i in range(3):
            ldb.insert_link(
                conn,
                local_task_id=f"t_{i}", mc_task_id=f"t_mc_{i}",
                mc_org_id="o", mc_project_id="p", mc_agent_id="a",
                source="pulled", local_status="ready",
                last_pulled_at=0,
            )
        ldb.update_link_state(conn, "t_0", push_dirty=1)
        ldb.insert_comment_link(
            conn, local_comment_id=1, mc_comment_id="cmt_1",
            local_task_id="t_0", source="pulled",
        )
    finally:
        conn.close()

    result = plugin_api._build_status(
        auth_path=auth_path,
        links_db_path=links_db_path,
    )
    assert result["links_total"] == 3
    assert result["links_dirty"] == 1
    assert result["comments_linked"] == 1


def test_remaps_runtime_cursor_keys(plugin_api, auth_path, links_db_path, monkeypatch):
    """runtime.get_status() exposes 'pull_events_cursor' and
    'push_kanban_events_cursor'; the response renames them to
    'events_cursor' and 'kanban_events_cursor'."""
    from mission_control import runtime as rt
    fake_status = {
        "pull_events_cursor": 12345,
        "push_kanban_events_cursor": 67890,
        "loops_running": True,
        "status": "running",
        "pull_last_success_at": 1000,
        "push_last_success_at": 2000,
        "pull_consecutive_errors": 1,
        "push_consecutive_errors": 0,
        "pull_last_error": None,
        "push_last_error": None,
        "started_at": 500,
        "last_thread_error": None,
    }
    with patch.object(rt, "get_status", return_value=fake_status):
        result = plugin_api._build_status(
            auth_path=auth_path,
            links_db_path=links_db_path,
        )
    assert result["events_cursor"] == 12345
    assert result["kanban_events_cursor"] == 67890
    assert result["loops_running"] is True
    assert result["status"] == "running"
    assert result["last_pull_ok_at"] == 1000
    assert result["last_push_ok_at"] == 2000
    assert result["consecutive_pull_errors"] == 1


def test_router_status_endpoint_returns_dict(plugin_api):
    """The /status endpoint coroutine returns a dict."""
    import asyncio
    result = asyncio.run(plugin_api.status())
    assert isinstance(result, dict)
    assert "registered" in result
