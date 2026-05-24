"""Tests for the register(ctx) loop-startup guard.

The four conditions:
  1. URL unset → no loop, no error.
  2. _HERMES_GATEWAY!=1 → no loop (not in gateway).
  3. _HERMES_GATEWAY=1 + HERMES_KANBAN_TASK set → no loop (we're a worker).
  4. _HERMES_GATEWAY=1, not in worker, auth.json present → loop starts.

Tool + CLI must register unconditionally (1-3 above all still register
them; only loop startup differs).
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import mission_control
from mission_control import config as cfg


class _FakeCtx:
    """Minimal stand-in for PluginContext capturing what was registered."""
    def __init__(self):
        self.tools: list[dict] = []
        self.cli_commands: list[dict] = []

    def register_tool(self, **kw):
        self.tools.append(kw)

    def register_cli_command(self, **kw):
        self.cli_commands.append(kw)


@pytest.fixture(autouse=True)
def reset_cache():
    cfg._reset_cache_for_tests()


@pytest.fixture
def auth_present(tmp_path, monkeypatch):
    """Write a valid auth.json under Path.home() (mocked)."""
    home = tmp_path
    monkeypatch.setattr(Path, "home", lambda: home)
    auth_path = home / ".hermes" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.write_text(json.dumps({
        "providers": {
            "mission_control": {
                "url": "https://mc.example.com",
                "org_id": "org_1",
                "agent_id": "agt_1",
                "agent_key": "mcagt_x",
                "connector_id": "cnn_1",
                "connector_key": "mccnn_x",
                "registered_at": 1,
            }
        }
    }))
    return auth_path


# ── tool + CLI always register ─────────────────────────────────────


def test_register_always_registers_tool(monkeypatch):
    monkeypatch.delenv("HERMES_MC_URL", raising=False)
    ctx = _FakeCtx()
    with patch("mission_control.runtime.start") as start_mock:
        mission_control.register(ctx)
    assert len(ctx.tools) == 1
    assert ctx.tools[0]["name"] == "mc_promote_task"
    start_mock.assert_not_called()


def test_register_always_registers_cli(monkeypatch):
    monkeypatch.delenv("HERMES_MC_URL", raising=False)
    ctx = _FakeCtx()
    with patch("mission_control.runtime.start") as start_mock:
        mission_control.register(ctx)
    assert len(ctx.cli_commands) == 1
    assert ctx.cli_commands[0]["name"] == "mc"
    start_mock.assert_not_called()


# ── loop-startup guard ─────────────────────────────────────────────


def test_loops_not_started_when_url_unset(monkeypatch):
    monkeypatch.delenv("HERMES_MC_URL", raising=False)
    monkeypatch.setenv("_HERMES_GATEWAY", "1")
    ctx = _FakeCtx()
    with patch("mission_control.runtime.start") as start_mock:
        mission_control.register(ctx)
    start_mock.assert_not_called()


def test_loops_not_started_when_not_in_gateway(monkeypatch, auth_present):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    ctx = _FakeCtx()
    with patch("mission_control.runtime.start") as start_mock:
        mission_control.register(ctx)
    start_mock.assert_not_called()


def test_loops_not_started_in_worker_subprocess(monkeypatch, auth_present):
    """Workers inherit _HERMES_GATEWAY=1 from the gateway; HERMES_KANBAN_TASK
    distinguishes them."""
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("_HERMES_GATEWAY", "1")
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_abc123")
    ctx = _FakeCtx()
    with patch("mission_control.runtime.start") as start_mock:
        mission_control.register(ctx)
    start_mock.assert_not_called()


def test_loops_not_started_when_auth_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("_HERMES_GATEWAY", "1")
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    # No auth.json present
    ctx = _FakeCtx()
    with patch("mission_control.runtime.start") as start_mock:
        mission_control.register(ctx)
    start_mock.assert_not_called()


def test_loops_started_when_all_conditions_met(monkeypatch, auth_present):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("_HERMES_GATEWAY", "1")
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    ctx = _FakeCtx()
    with patch("mission_control.runtime.start") as start_mock:
        mission_control.register(ctx)
    start_mock.assert_called_once()
    # Tool + CLI also registered
    assert len(ctx.tools) == 1
    assert len(ctx.cli_commands) == 1


def test_tool_handler_returns_json_string(monkeypatch):
    """The tool handler returns its result as a JSON string."""
    monkeypatch.delenv("HERMES_MC_URL", raising=False)
    with patch("mission_control.tools.mc_promote_task",
               return_value={"mc_task_id": "t_mc_x", "already_linked": False}):
        result = mission_control._tool_handler({"local_task_id": "t_abc"})
    assert isinstance(result, str)
    parsed = json.loads(result)
    assert parsed["mc_task_id"] == "t_mc_x"


def test_tool_handler_errors_on_missing_local_task_id():
    result = mission_control._tool_handler({})
    parsed = json.loads(result)
    assert parsed.get("code") == "mc.bad_args"
