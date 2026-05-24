"""Tests for mc_promote_task (the LLM-callable tool)."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mission_control import tools
from mission_control import config as cfg
from mission_control import client as mc_client
from mission_control import links_db as ldb


@pytest.fixture
def env_set(monkeypatch):
    """Common env vars for the tool.

    Sets HERMES_MC_BOARD=default so cfg.load_env() resolves to the same
    kanban board that the test fixtures initialise via kb.connect() /
    kb.init_db() (which both default to the 'default' board).
    """
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("HERMES_MC_BOARD", "default")
    monkeypatch.delenv("HERMES_MC_DEFAULT_PROJECT_SLUG", raising=False)


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
def auth_files(tmp_path, kanban_home):
    """Write a valid auth.json + projects.json. Returns paths."""
    auth_path = tmp_path / ".hermes" / "auth.json"
    auth_path.parent.mkdir(exist_ok=True)
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
    projects_path = auth_path.parent / "mission-control" / "projects.json"
    projects_path.parent.mkdir(parents=True)
    projects_path.write_text(json.dumps([
        {"id": "prj_default", "slug": "default", "name": "Default"},
        {"id": "prj_research", "slug": "research", "name": "Research"},
    ]))
    links_db_path = auth_path.parent / "mission-control" / "links.db"
    return auth_path, links_db_path


@pytest.fixture
def mock_client():
    c = MagicMock()
    c.aclose = AsyncMock()
    c.tasks_create = AsyncMock()
    c.external_ref_create = AsyncMock(return_value={"external_ref": {"id": "xrf_1"}})
    return c


@pytest.fixture(autouse=True)
def reset_cache():
    cfg._reset_cache_for_tests()


# ── precondition errors ──────────────────────────────────────────


def test_returns_not_registered_when_url_unset(monkeypatch, auth_files):
    monkeypatch.delenv("HERMES_MC_URL", raising=False)
    auth_path, links_db_path = auth_files
    result = tools.mc_promote_task(
        "t_anything",
        auth_path=auth_path, links_db_path=links_db_path,
    )
    assert result["code"] == "mc.not_registered"


def test_returns_not_registered_when_auth_missing(env_set, tmp_path, kanban_home):
    bad_auth = tmp_path / "no-auth.json"
    bad_links = tmp_path / "no-links.db"
    result = tools.mc_promote_task(
        "t_anything",
        auth_path=bad_auth, links_db_path=bad_links,
    )
    assert result["code"] == "mc.not_registered"


def test_returns_no_project_when_no_slug(env_set, auth_files):
    auth_path, links_db_path = auth_files
    result = tools.mc_promote_task(
        "t_anything",  # no slug, no default
        auth_path=auth_path, links_db_path=links_db_path,
    )
    assert result["code"] == "mc.no_project"


def test_returns_unknown_project_when_slug_not_in_cache(env_set, auth_files):
    auth_path, links_db_path = auth_files
    result = tools.mc_promote_task(
        "t_anything", "does-not-exist",
        auth_path=auth_path, links_db_path=links_db_path,
    )
    assert result["code"] == "mc.unknown_project"


def test_returns_local_task_not_found(env_set, auth_files, mock_client):
    auth_path, links_db_path = auth_files
    with patch("mission_control.tools.mc_client.McClient", return_value=mock_client):
        result = tools.mc_promote_task(
            "t_nonexistent", "default",
            auth_path=auth_path, links_db_path=links_db_path,
        )
    assert result["code"] == "mc.local_task_not_found"
    # tasks_create was never called
    mock_client.tasks_create.assert_not_called()


# ── happy path ───────────────────────────────────────────────────


def test_promotes_local_task_to_mc(env_set, auth_files, mock_client):
    import hermes_cli.kanban_db as kb
    with kb.connect() as kconn:
        local_id = kb.create_task(kconn, title="Local Task", body="Body", assignee="agt_self")

    mock_client.tasks_create.return_value = {"task": {"id": "t_mc_xyz", "updated_at": 9999}}
    auth_path, links_db_path = auth_files

    with patch("mission_control.tools.mc_client.McClient", return_value=mock_client):
        result = tools.mc_promote_task(
            local_id, "default",
            auth_path=auth_path, links_db_path=links_db_path,
        )

    assert result["mc_task_id"] == "t_mc_xyz"
    assert result["already_linked"] is False

    # tasks_create called with correct args
    call = mock_client.tasks_create.call_args
    assert call.kwargs["connector_key"] == "mccnn_x"
    assert call.kwargs["project_id"] == "prj_default"
    assert call.kwargs["title"] == "Local Task"
    assert call.kwargs["agent_id"] == "agt_self"
    assert call.kwargs["idempotency_key"] == f"hermes:{local_id}"
    assert call.kwargs["metadata"]["origin"] == "hermes"

    # external_ref_create called with AGENT key
    erc = mock_client.external_ref_create.call_args
    assert erc.kwargs["agent_key"] == "mcagt_x"
    assert erc.kwargs["source_kind"] == "hermes"
    assert erc.kwargs["source_id"] == "agt_self"
    assert erc.kwargs["external_id"] == local_id
    assert erc.kwargs["resource_type"] == "task"
    assert erc.kwargs["resource_id"] == "t_mc_xyz"

    # mc_links row created
    ldb_conn = ldb.connect(str(links_db_path))
    try:
        link = ldb.get_link(ldb_conn, local_id)
        assert link is not None
        assert link.mc_task_id == "t_mc_xyz"
        assert link.source == "pushed"
    finally:
        ldb_conn.close()


def test_uses_default_project_slug_from_env(monkeypatch, auth_files, mock_client, kanban_home):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("HERMES_MC_BOARD", "default")
    monkeypatch.setenv("HERMES_MC_DEFAULT_PROJECT_SLUG", "research")

    import hermes_cli.kanban_db as kb
    with kb.connect() as kconn:
        local_id = kb.create_task(kconn, title="X", assignee="agt_self")

    mock_client.tasks_create.return_value = {"task": {"id": "t_mc_r", "updated_at": 1}}
    auth_path, links_db_path = auth_files

    with patch("mission_control.tools.mc_client.McClient", return_value=mock_client):
        result = tools.mc_promote_task(
            local_id,  # no slug
            auth_path=auth_path, links_db_path=links_db_path,
        )
    assert result["mc_task_id"] == "t_mc_r"
    assert mock_client.tasks_create.call_args.kwargs["project_id"] == "prj_research"


def test_already_linked_returns_existing(env_set, auth_files, mock_client):
    import hermes_cli.kanban_db as kb
    with kb.connect() as kconn:
        local_id = kb.create_task(kconn, title="X", assignee="agt_self")

    auth_path, links_db_path = auth_files
    # Pre-link
    ldb_conn = ldb.connect(str(links_db_path))
    try:
        ldb.insert_link(
            ldb_conn,
            local_task_id=local_id,
            mc_task_id="t_existing",
            mc_org_id="org_1",
            mc_project_id="prj_default",
            mc_agent_id="agt_self",
            source="pushed",
            local_status="ready",
            last_pulled_at=0,
        )
    finally:
        ldb_conn.close()

    with patch("mission_control.tools.mc_client.McClient", return_value=mock_client):
        result = tools.mc_promote_task(
            local_id, "default",
            auth_path=auth_path, links_db_path=links_db_path,
        )

    assert result["mc_task_id"] == "t_existing"
    assert result["already_linked"] is True
    mock_client.tasks_create.assert_not_called()


# ── idempotency conflict ─────────────────────────────────────────


def test_idempotency_conflict_with_matching_link_treats_as_success(
    env_set, auth_files, mock_client,
):
    import hermes_cli.kanban_db as kb
    with kb.connect() as kconn:
        local_id = kb.create_task(kconn, title="X", assignee="agt_self")

    auth_path, links_db_path = auth_files
    # First call: conflict with existing_task_id=t_dupe, no link present
    mock_client.tasks_create.side_effect = mc_client.IdempotencyConflict(
        existing_task_id="t_dupe",
    )

    with patch("mission_control.tools.mc_client.McClient", return_value=mock_client):
        result = tools.mc_promote_task(
            local_id, "default",
            auth_path=auth_path, links_db_path=links_db_path,
        )
    # With NO link present, this is the orphan path
    assert result["code"] == "mc.idempotency_conflict_orphan"

    # Now re-establish link mapping our local→t_dupe and retry
    ldb_conn = ldb.connect(str(links_db_path))
    try:
        ldb.insert_link(
            ldb_conn,
            local_task_id=local_id,
            mc_task_id="t_dupe",
            mc_org_id="org_1",
            mc_project_id="prj_default",
            mc_agent_id="agt_self",
            source="pushed",
            local_status="ready",
            last_pulled_at=0,
        )
    finally:
        ldb_conn.close()

    # Now mc_promote_task short-circuits at the link check (already_linked=True)
    with patch("mission_control.tools.mc_client.McClient", return_value=mock_client):
        result = tools.mc_promote_task(
            local_id, "default",
            auth_path=auth_path, links_db_path=links_db_path,
        )
    assert result["already_linked"] is True
    assert result["mc_task_id"] == "t_dupe"


def test_idempotency_conflict_with_different_local_task(env_set, auth_files, mock_client):
    """The MC task with our idempotency key is linked to a DIFFERENT local
    task — surface the mismatch as an error."""
    import hermes_cli.kanban_db as kb
    with kb.connect() as kconn:
        local_id = kb.create_task(kconn, title="X", assignee="agt_self")
        other_local = kb.create_task(kconn, title="Y", assignee="agt_self")

    auth_path, links_db_path = auth_files
    ldb_conn = ldb.connect(str(links_db_path))
    try:
        ldb.insert_link(
            ldb_conn,
            local_task_id=other_local,
            mc_task_id="t_dupe",
            mc_org_id="org_1",
            mc_project_id="prj_default",
            mc_agent_id="agt_self",
            source="pushed",
            local_status="ready",
            last_pulled_at=0,
        )
    finally:
        ldb_conn.close()

    mock_client.tasks_create.side_effect = mc_client.IdempotencyConflict(
        existing_task_id="t_dupe",
    )

    with patch("mission_control.tools.mc_client.McClient", return_value=mock_client):
        result = tools.mc_promote_task(
            local_id, "default",
            auth_path=auth_path, links_db_path=links_db_path,
        )
    assert result["code"] == "mc.idempotency_conflict_mismatch"
    assert result["existing_mc_task_id"] == "t_dupe"
    assert result["existing_local_task_id"] == other_local


# ── best-effort external_ref ─────────────────────────────────────


def test_external_ref_failure_is_non_fatal(env_set, auth_files, mock_client):
    """If external_ref_create raises, promote still succeeds (logs warning)."""
    import hermes_cli.kanban_db as kb
    with kb.connect() as kconn:
        local_id = kb.create_task(kconn, title="X", assignee="agt_self")

    mock_client.tasks_create.return_value = {"task": {"id": "t_mc_y", "updated_at": 1}}
    mock_client.external_ref_create.side_effect = Exception("xrf failed")

    auth_path, links_db_path = auth_files
    with patch("mission_control.tools.mc_client.McClient", return_value=mock_client):
        result = tools.mc_promote_task(
            local_id, "default",
            auth_path=auth_path, links_db_path=links_db_path,
        )
    assert result["mc_task_id"] == "t_mc_y"
    assert result["already_linked"] is False
