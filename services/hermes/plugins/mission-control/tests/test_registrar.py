"""Tests for registrar.register and refresh_projects (mocked MC client)."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mission_control import registrar
from mission_control import config as cfg
from mission_control import client as mc_client
from mission_control import links_db as ldb


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
def mock_client_factory():
    """Returns a function that builds a MagicMock McClient with
    AsyncMocks for every endpoint we use. Yields the factory; tests
    patch mc_client.McClient(...) to return the prepared mock."""
    def make():
        c = MagicMock()
        c.aclose = AsyncMock()
        c.me = AsyncMock(return_value={"org": {"id": "org_real"}, "principal_type": "agent", "principal_id": "agt_x"})
        c.agents_list = AsyncMock(return_value={"agents": []})
        c.agents_create = AsyncMock(return_value={
            "agent": {"id": "agt_new"},
            "key": "mcagt_secret_new",
        })
        c.agents_rotate_key = AsyncMock(return_value={"key": "mcagt_rotated"})
        c.connectors_list = AsyncMock(return_value={"connectors": []})
        c.connectors_create = AsyncMock(return_value={
            "connector": {"id": "cnn_new"},
            "key": "mccnn_secret_new",
        })
        c.connectors_rotate_key = AsyncMock(return_value={"key": "mccnn_rotated"})
        c.projects_list = AsyncMock(return_value={
            "projects": [{"id": "prj_1", "slug": "default", "name": "Default"}],
            "next_cursor": None,
        })
        c.events_list = AsyncMock(return_value={
            "events": [{"id": 42}],
            "next_cursor": None,
        })
        return c
    return make


# ── happy path ────────────────────────────────────────────────────


async def test_register_happy_path_first_time(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        auth = await registrar.register(env, auth_path, links_db_path, "mcpat_x", name="vm1")

    assert isinstance(auth, cfg.Auth)
    assert auth.agent_id == "agt_new"
    assert auth.agent_key == "mcagt_secret_new"
    assert auth.connector_id == "cnn_new"
    assert auth.connector_key == "mccnn_secret_new"
    assert auth.org_id == "org_real"

    mock_c.agents_create.assert_awaited_once_with(pat="mcpat_x", name="vm1", kind="hermes")
    mock_c.connectors_create.assert_awaited_once_with(pat="mcpat_x", name="vm1", kind="hermes")
    mock_c.aclose.assert_awaited()


async def test_register_rotates_when_agent_already_exists(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()
    mock_c.agents_list.return_value = {"agents": [{"id": "agt_existing", "name": "vm1"}]}

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        auth = await registrar.register(env, auth_path, links_db_path, "mcpat_x", name="vm1")

    mock_c.agents_create.assert_not_called()
    mock_c.agents_rotate_key.assert_awaited_once_with(pat="mcpat_x", agent_id="agt_existing")
    assert auth.agent_id == "agt_existing"
    assert auth.agent_key == "mcagt_rotated"


async def test_register_rotates_when_connector_already_exists(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()
    mock_c.connectors_list.return_value = {"connectors": [{"id": "cnn_existing", "name": "vm1"}]}

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        auth = await registrar.register(env, auth_path, links_db_path, "mcpat_x", name="vm1")

    mock_c.connectors_create.assert_not_called()
    mock_c.connectors_rotate_key.assert_awaited_once_with(pat="mcpat_x", connector_id="cnn_existing")
    assert auth.connector_id == "cnn_existing"
    assert auth.connector_key == "mccnn_rotated"


async def test_register_uses_env_agent_name_when_no_override(env, tmp_path, mock_client_factory):
    env.agent_name = "vm-from-env"
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        await registrar.register(env, auth_path, links_db_path, "mcpat_x")

    mock_c.agents_create.assert_awaited_once_with(pat="mcpat_x", name="vm-from-env", kind="hermes")


async def test_register_falls_back_to_hostname(env, tmp_path, mock_client_factory):
    env.agent_name = None
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        with patch("mission_control.registrar.socket.gethostname", return_value="my-host"):
            cfg._reset_cache_for_tests()
            await registrar.register(env, auth_path, links_db_path, "mcpat_x")

    mock_c.agents_create.assert_awaited_once_with(pat="mcpat_x", name="my-host", kind="hermes")


# ── connector unavailable ─────────────────────────────────────────


async def test_register_raises_when_connector_list_404(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()
    mock_c.connectors_list.side_effect = mc_client.NotFound("no such route")

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        with pytest.raises(registrar.ConnectorRoutesUnavailable) as exc:
            await registrar.register(env, auth_path, links_db_path, "mcpat_x", name="vm1")
    assert exc.value.code == "mc.connector_routes_unavailable"


async def test_register_raises_when_connector_create_403(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()
    mock_c.connectors_create.side_effect = mc_client.AuthFailed("403")

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        with pytest.raises(registrar.ConnectorRoutesUnavailable):
            await registrar.register(env, auth_path, links_db_path, "mcpat_x", name="vm1")


# ── projects cache ────────────────────────────────────────────────


async def test_register_caches_project_list(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()
    mock_c.projects_list.return_value = {
        "projects": [
            {"id": "prj_1", "slug": "research", "name": "Research"},
            {"id": "prj_2", "slug": "demo", "name": "Demo"},
        ],
        "next_cursor": None,
    }

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        await registrar.register(env, auth_path, links_db_path, "mcpat_x", name="vm1")

    projects_path = auth_path.parent / "mission-control" / "projects.json"
    assert projects_path.exists()
    data = json.loads(projects_path.read_text())
    assert len(data) == 2
    assert data[0]["slug"] == "research"
    assert data[1]["slug"] == "demo"


async def test_register_paginates_project_list(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()
    # Two pages of results
    page1 = {"projects": [{"id": "prj_1", "slug": "a", "name": "A"}], "next_cursor": "p2"}
    page2 = {"projects": [{"id": "prj_2", "slug": "b", "name": "B"}], "next_cursor": None}
    mock_c.projects_list.side_effect = [page1, page2]

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        await registrar.register(env, auth_path, links_db_path, "mcpat_x", name="vm1")

    projects = json.loads((auth_path.parent / "mission-control" / "projects.json").read_text())
    assert {p["id"] for p in projects} == {"prj_1", "prj_2"}
    assert mock_c.projects_list.await_count == 2


# ── events cursor init ────────────────────────────────────────────


async def test_register_initializes_events_cursor_to_head(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()
    mock_c.events_list.return_value = {"events": [{"id": 1234}], "next_cursor": None}

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        await registrar.register(env, auth_path, links_db_path, "mcpat_x", name="vm1")

    ldb_conn = ldb.connect(str(links_db_path))
    try:
        assert ldb.get_cursor(ldb_conn, "events") == 1234
    finally:
        ldb_conn.close()


async def test_register_uses_order_desc_to_get_head_not_oldest(env, tmp_path, mock_client_factory):
    """Regression: a prior version passed `order='asc'` (default), which
    returns the OLDEST event on an org with history → the plugin would
    replay every prior event on first connect. Must use order='desc'."""
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        await registrar.register(env, auth_path, links_db_path, "mcpat_x", name="vm1")

    # The cursor-init call passed order='desc' + limit=1
    cursor_init_calls = [
        c for c in mock_c.events_list.call_args_list
        if c.kwargs.get("limit") == 1
    ]
    assert cursor_init_calls, "expected at least one events_list(limit=1) call"
    last = cursor_init_calls[-1]
    assert last.kwargs.get("order") == "desc", (
        f"events-cursor init must pass order='desc' to get the head, "
        f"got kwargs={last.kwargs}"
    )


async def test_register_leaves_cursor_at_zero_when_events_empty(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    links_db_path = tmp_path / "links.db"
    mock_c = mock_client_factory()
    mock_c.events_list.return_value = {"events": [], "next_cursor": None}

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        cfg._reset_cache_for_tests()
        await registrar.register(env, auth_path, links_db_path, "mcpat_x", name="vm1")

    ldb_conn = ldb.connect(str(links_db_path))
    try:
        assert ldb.get_cursor(ldb_conn, "events") == 0
    finally:
        ldb_conn.close()


# ── refresh_projects ──────────────────────────────────────────────


async def test_refresh_projects_returns_count_and_writes(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    mock_c = mock_client_factory()
    mock_c.projects_list.return_value = {
        "projects": [{"id": "prj_1", "slug": "p", "name": "P"}],
        "next_cursor": None,
    }

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        count = await registrar.refresh_projects(env, auth_path, "mcpat_x")

    assert count == 1
    cached = json.loads((auth_path.parent / "mission-control" / "projects.json").read_text())
    assert len(cached) == 1


async def test_refresh_projects_overwrites_existing(env, tmp_path, mock_client_factory):
    auth_path = tmp_path / "auth.json"
    projects_path = auth_path.parent / "mission-control" / "projects.json"
    projects_path.parent.mkdir(parents=True)
    projects_path.write_text(json.dumps([{"id": "stale", "slug": "stale", "name": "Stale"}]))

    mock_c = mock_client_factory()
    mock_c.projects_list.return_value = {
        "projects": [{"id": "prj_fresh", "slug": "fresh", "name": "Fresh"}],
        "next_cursor": None,
    }

    with patch("mission_control.registrar.mc_client.McClient", return_value=mock_c):
        await registrar.refresh_projects(env, auth_path, "mcpat_x")

    cached = json.loads(projects_path.read_text())
    assert len(cached) == 1
    assert cached[0]["slug"] == "fresh"
