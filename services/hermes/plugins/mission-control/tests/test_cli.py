"""Tests for the hermes mc CLI surface.

Each subcommand is built via setup() into an argparse parser, then
parsed and dispatched through handle(). Network calls are mocked
through the underlying registrar/tools/client modules.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mission_control import cli
from mission_control import config as cfg
from mission_control import client as mc_client
from mission_control import links_db as ldb


def _build_parser():
    """Build a fresh argparse parser with cli.setup() applied."""
    p = argparse.ArgumentParser(prog="hermes mc")
    cli.setup(p)
    return p


@pytest.fixture(autouse=True)
def reset_cache():
    cfg._reset_cache_for_tests()


@pytest.fixture
def env_set(monkeypatch):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")


@pytest.fixture
def auth_files(tmp_path):
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(json.dumps({
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
    links_db_path = tmp_path / "links.db"
    return auth_path, links_db_path


# ── parser construction ────────────────────────────────────────────


def test_parser_accepts_all_subcommands():
    p = _build_parser()
    for sub in ("register", "status", "refresh-projects", "promote", "unlink", "test"):
        args = p.parse_args([sub, "x"] if sub in ("promote", "unlink") else [sub])
        assert args.mc_subcommand == sub


def test_parser_rejects_unknown_subcommand():
    p = _build_parser()
    with pytest.raises(SystemExit):
        p.parse_args(["bogus"])


# ── register ───────────────────────────────────────────────────────


def test_register_dispatches_to_registrar(env_set, auth_files, monkeypatch):
    auth_path, links_db_path = auth_files
    monkeypatch.setenv("HERMES_MC_USER_PAT", "mcpat_xxx")

    fake_auth = cfg.Auth(
        url="https://mc.example.com", org_id="org_1", agent_id="agt_1",
        agent_key="mcagt_x", connector_id="cnn_1", connector_key="mccnn_x",
        registered_at=1,
    )
    register_mock = AsyncMock(return_value=fake_auth)
    with patch("mission_control.cli.registrar.register", new=register_mock):
        p = _build_parser()
        args = p.parse_args([
            "--auth-path", str(auth_path),
            "--links-db-path", str(links_db_path),
            "register", "--name", "my-vm",
        ])
        rc = cli.handle(args)
    assert rc == 0
    register_mock.assert_awaited_once()
    kwargs = register_mock.call_args.kwargs
    assert kwargs["name"] == "my-vm"


def test_register_uses_pat_arg_over_env(env_set, auth_files, monkeypatch):
    auth_path, links_db_path = auth_files
    monkeypatch.setenv("HERMES_MC_USER_PAT", "env-pat")
    fake_auth = cfg.Auth(
        url="x", org_id="x", agent_id="x", agent_key="x",
        connector_id="x", connector_key="x", registered_at=1,
    )
    register_mock = AsyncMock(return_value=fake_auth)
    with patch("mission_control.cli.registrar.register", new=register_mock):
        p = _build_parser()
        args = p.parse_args([
            "--auth-path", str(auth_path),
            "--links-db-path", str(links_db_path),
            "register", "--pat", "arg-pat",
        ])
        cli.handle(args)
    pat_arg = register_mock.call_args.args[3]  # 4th positional
    assert pat_arg == "arg-pat"


def test_register_errors_when_no_pat(env_set, auth_files, monkeypatch, capsys):
    monkeypatch.delenv("HERMES_MC_USER_PAT", raising=False)
    auth_path, links_db_path = auth_files
    p = _build_parser()
    args = p.parse_args([
        "--auth-path", str(auth_path),
        "--links-db-path", str(links_db_path),
        "register",
    ])
    rc = cli.handle(args)
    assert rc == 2
    assert "no PAT" in capsys.readouterr().err


def test_register_handles_connector_unavailable(env_set, auth_files, monkeypatch, capsys):
    auth_path, links_db_path = auth_files
    monkeypatch.setenv("HERMES_MC_USER_PAT", "mcpat_x")
    from mission_control.registrar import ConnectorRoutesUnavailable
    register_mock = AsyncMock(side_effect=ConnectorRoutesUnavailable())
    with patch("mission_control.cli.registrar.register", new=register_mock):
        p = _build_parser()
        args = p.parse_args([
            "--auth-path", str(auth_path),
            "--links-db-path", str(links_db_path),
            "register",
        ])
        rc = cli.handle(args)
    assert rc == 1
    err = capsys.readouterr().err
    assert "mc.connector_routes_unavailable" in err


# ── status ─────────────────────────────────────────────────────────


def test_status_when_url_unset(monkeypatch, auth_files, capsys):
    monkeypatch.delenv("HERMES_MC_URL", raising=False)
    auth_path, links_db_path = auth_files
    p = _build_parser()
    args = p.parse_args([
        "--auth-path", str(auth_path),
        "--links-db-path", str(links_db_path),
        "status",
    ])
    rc = cli.handle(args)
    assert rc == 1
    assert "not configured" in capsys.readouterr().out


def test_status_when_not_registered(env_set, tmp_path, capsys):
    no_auth = tmp_path / "nope.json"
    p = _build_parser()
    args = p.parse_args([
        "--auth-path", str(no_auth),
        "--links-db-path", str(tmp_path / "nope.db"),
        "status",
    ])
    rc = cli.handle(args)
    assert rc == 1
    assert "not registered" in capsys.readouterr().out


def test_status_prints_full_block(env_set, auth_files, capsys):
    auth_path, links_db_path = auth_files
    # Pre-populate cursor
    conn = ldb.connect(str(links_db_path))
    try:
        ldb.set_cursor(conn, "events", 42)
    finally:
        conn.close()
    p = _build_parser()
    args = p.parse_args([
        "--auth-path", str(auth_path),
        "--links-db-path", str(links_db_path),
        "status",
    ])
    rc = cli.handle(args)
    assert rc == 0
    out = capsys.readouterr().out
    assert "url:" in out
    assert "https://mc.example.com" in out
    assert "events_cursor: 42" in out
    assert "loops_running" in out


# ── refresh-projects ──────────────────────────────────────────────


def test_refresh_projects_dispatches(env_set, auth_files, monkeypatch):
    auth_path, _ = auth_files
    monkeypatch.setenv("HERMES_MC_USER_PAT", "mcpat_x")
    refresh_mock = AsyncMock(return_value=3)
    with patch("mission_control.cli.registrar.refresh_projects", new=refresh_mock):
        p = _build_parser()
        args = p.parse_args([
            "--auth-path", str(auth_path),
            "refresh-projects",
        ])
        rc = cli.handle(args)
    assert rc == 0
    refresh_mock.assert_awaited_once()


def test_refresh_projects_errors_without_pat(env_set, auth_files, monkeypatch, capsys):
    monkeypatch.delenv("HERMES_MC_USER_PAT", raising=False)
    auth_path, _ = auth_files
    p = _build_parser()
    args = p.parse_args([
        "--auth-path", str(auth_path),
        "refresh-projects",
    ])
    rc = cli.handle(args)
    assert rc == 2


# ── promote ────────────────────────────────────────────────────────


def test_promote_success(env_set, auth_files, capsys):
    auth_path, links_db_path = auth_files
    with patch("mission_control.cli.mc_tools.mc_promote_task",
               return_value={"mc_task_id": "t_mc_new", "already_linked": False}):
        p = _build_parser()
        args = p.parse_args([
            "--auth-path", str(auth_path),
            "--links-db-path", str(links_db_path),
            "promote", "t_abc", "--project", "default",
        ])
        rc = cli.handle(args)
    assert rc == 0
    assert "Promoted: t_abc" in capsys.readouterr().out


def test_promote_already_linked(env_set, auth_files, capsys):
    auth_path, links_db_path = auth_files
    with patch("mission_control.cli.mc_tools.mc_promote_task",
               return_value={"mc_task_id": "t_existing", "already_linked": True}):
        p = _build_parser()
        args = p.parse_args([
            "--auth-path", str(auth_path),
            "--links-db-path", str(links_db_path),
            "promote", "t_abc",
        ])
        rc = cli.handle(args)
    assert rc == 0
    out = capsys.readouterr().out
    assert "Already linked" in out


def test_promote_error(env_set, auth_files, capsys):
    auth_path, links_db_path = auth_files
    with patch("mission_control.cli.mc_tools.mc_promote_task",
               return_value={"error": "no project", "code": "mc.no_project"}):
        p = _build_parser()
        args = p.parse_args([
            "--auth-path", str(auth_path),
            "--links-db-path", str(links_db_path),
            "promote", "t_abc",
        ])
        rc = cli.handle(args)
    assert rc == 1
    assert "mc.no_project" in capsys.readouterr().err


# ── unlink ────────────────────────────────────────────────────────


def test_unlink_existing(env_set, auth_files, capsys):
    auth_path, links_db_path = auth_files
    conn = ldb.connect(str(links_db_path))
    try:
        ldb.insert_link(
            conn, local_task_id="t_local", mc_task_id="t_mc",
            mc_org_id="o", mc_project_id="p", mc_agent_id="a",
            source="pushed", local_status="ready", last_pulled_at=0,
        )
    finally:
        conn.close()

    p = _build_parser()
    args = p.parse_args([
        "--auth-path", str(auth_path),
        "--links-db-path", str(links_db_path),
        "unlink", "t_local",
    ])
    rc = cli.handle(args)
    assert rc == 0
    out = capsys.readouterr().out
    assert "unlinked: t_local" in out
    assert "MC task NOT deleted" in out

    conn = ldb.connect(str(links_db_path))
    try:
        assert ldb.get_link(conn, "t_local") is None
    finally:
        conn.close()


def test_unlink_nonexistent(env_set, auth_files, capsys):
    auth_path, links_db_path = auth_files
    # Create empty links.db
    ldb.connect(str(links_db_path)).close()
    p = _build_parser()
    args = p.parse_args([
        "--auth-path", str(auth_path),
        "--links-db-path", str(links_db_path),
        "unlink", "t_missing",
    ])
    rc = cli.handle(args)
    assert rc == 0
    out = capsys.readouterr().out
    assert "no link for t_missing" in out


# ── test ──────────────────────────────────────────────────────────


def test_smoke_test_all_pass(env_set, auth_files, capsys):
    auth_path, _ = auth_files
    mock_c = MagicMock()
    mock_c.aclose = AsyncMock()
    mock_c.me = AsyncMock(return_value={})
    mock_c.events_list = AsyncMock(return_value={"events": [], "next_cursor": None})

    with patch("mission_control.cli.mc_client.McClient", return_value=mock_c):
        p = _build_parser()
        args = p.parse_args([
            "--auth-path", str(auth_path),
            "test",
        ])
        rc = cli.handle(args)
    assert rc == 0
    out = capsys.readouterr().out
    assert "GET /v1/me (agent key):     PASS" in out
    assert "GET /v1/me (connector key): PASS" in out
    assert "GET /v1/events (connector): PASS" in out


def test_smoke_test_failure(env_set, auth_files, capsys):
    auth_path, _ = auth_files
    mock_c = MagicMock()
    mock_c.aclose = AsyncMock()
    mock_c.me = AsyncMock(side_effect=mc_client.AuthFailed("401"))
    mock_c.events_list = AsyncMock(return_value={"events": [], "next_cursor": None})

    with patch("mission_control.cli.mc_client.McClient", return_value=mock_c):
        p = _build_parser()
        args = p.parse_args([
            "--auth-path", str(auth_path),
            "test",
        ])
        rc = cli.handle(args)
    assert rc == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
