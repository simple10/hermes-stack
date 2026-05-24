"""End-to-end integration tests for the mission-control plugin.

Skipped unless MC_INTEGRATION_TEST_URL is set. The operator is
responsible for spinning up an MC deployment (typically via
``cd services/mission-control && MC_ADMIN_TOKEN=… pnpm dev``).

These tests exercise the full pipeline: registration, pull loop
(events stream), push reactor (kanban → MC PATCH/POST), comment
sync, auto-unblock, and the mc_promote_task tool.

Run with:

    export MC_INTEGRATION_TEST_URL=http://localhost:8787
    export MC_INTEGRATION_TEST_ADMIN_TOKEN=integration-test-token
    cd services/hermes/plugins/mission-control
    .venv/bin/pytest tests/integration/ -v -m integration
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path

import httpx
import pytest

from mission_control import apply as mc_apply
from mission_control import client as mc_client
from mission_control import config as cfg
from mission_control import links_db as ldb
from mission_control import pull as mc_pull
from mission_control import push as mc_push
from mission_control import registrar
from mission_control import tools as mc_tools


# ── markers ──────────────────────────────────────────────────────────


pytestmark = pytest.mark.integration


MC_URL = os.environ.get("MC_INTEGRATION_TEST_URL", "").strip()
MC_ADMIN_TOKEN = os.environ.get("MC_INTEGRATION_TEST_ADMIN_TOKEN", "").strip()


if not MC_URL:
    pytest.skip(
        "MC_INTEGRATION_TEST_URL not set — integration tests skipped",
        allow_module_level=True,
    )


# ── fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    """Isolated kanban_db under tmp_path."""
    import hermes_cli.kanban_db as kb
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("HERMES_MC_URL", MC_URL)
    return cfg.Env(
        url=MC_URL,
        user_pat=None,
        agent_name=f"integ-vm-{uuid.uuid4().hex[:8]}",
        board=None,
        poll_interval_s=2,
        default_project_slug=None,
        debug=True,
    )


@pytest.fixture
def auth_path(tmp_path):
    return tmp_path / ".hermes" / "auth.json"


@pytest.fixture
def links_db_path(tmp_path):
    return tmp_path / ".hermes" / "mission-control" / "links.db"


@pytest.fixture
async def fresh_org(env):
    """Bootstrap a fresh MC org and return (pat, org_id, project_id, project_slug).

    Uses /v1/bootstrap which can only be called once per DB. If the test
    DB has been bootstrapped already, we fall back to creating a new
    project via the existing PAT — but for true isolation operators
    should restart wrangler-dev between integration runs.
    """
    if not MC_ADMIN_TOKEN:
        pytest.skip("MC_INTEGRATION_TEST_ADMIN_TOKEN required for integration tests")

    slug_suffix = uuid.uuid4().hex[:8]
    async with httpx.AsyncClient(timeout=10) as http:
        # Try bootstrap; if it fails because already bootstrapped, the
        # operator must use a fresh DB. We don't attempt fallback recovery.
        bootstrap_resp = await http.post(
            f"{MC_URL}/v1/bootstrap",
            headers={"x-mc-admin-token": MC_ADMIN_TOKEN, "content-type": "application/json"},
            json={
                "email": f"integ-{slug_suffix}@example.com",
                "password": "test-password-1234",
                "name": "Integration Test User",
                "orgName": f"Integration Test Org {slug_suffix}",
                "orgSlug": f"integ-test-{slug_suffix}",
            },
        )
        if bootstrap_resp.status_code != 201:
            pytest.skip(
                f"MC bootstrap failed ({bootstrap_resp.status_code}); "
                "ensure MC is freshly started for integration tests. "
                f"Response: {bootstrap_resp.text[:200]}"
            )
        bootstrap = bootstrap_resp.json()
        pat = bootstrap["pat"]
        org_id = bootstrap["organization"]["id"]

        # Create a project
        proj_resp = await http.post(
            f"{MC_URL}/v1/projects",
            headers={"authorization": f"Bearer {pat}", "content-type": "application/json"},
            json={"name": "Integration Test Project", "slug": f"integ-{slug_suffix}"},
        )
        assert proj_resp.status_code == 201, proj_resp.text
        project = proj_resp.json()["project"]

    yield {
        "pat": pat,
        "org_id": org_id,
        "project_id": project["id"],
        "project_slug": project["slug"],
    }


@pytest.fixture
async def registered(env, auth_path, links_db_path, fresh_org):
    """Run the registrar against the fresh org and yield (auth, env, paths, fresh_org)."""
    cfg._reset_cache_for_tests()
    auth = await registrar.register(
        env,
        auth_path=auth_path,
        links_db_path=links_db_path,
        pat=fresh_org["pat"],
        name=env.agent_name,
    )
    yield {
        "auth": auth,
        "env": env,
        "auth_path": auth_path,
        "links_db_path": links_db_path,
        "fresh_org": fresh_org,
    }


@pytest.fixture
async def http_with_pat(fresh_org):
    """httpx client with PAT auth headers preset for operator-side calls."""
    async with httpx.AsyncClient(
        timeout=10,
        headers={"authorization": f"Bearer {fresh_org['pat']}", "content-type": "application/json"},
    ) as client:
        yield client


# ── helpers ──────────────────────────────────────────────────────────


async def _drain_pull(registered) -> int:
    """Run one full pull cycle and return events processed."""
    env = registered["env"]
    auth = registered["auth"]
    ldb_conn = ldb.connect(str(registered["links_db_path"]))
    try:
        client = mc_client.McClient(base_url=env.url)
        try:
            return await mc_pull.pull_once(env, auth, ldb_conn, client)
        finally:
            await client.aclose()
    finally:
        ldb_conn.close()


async def _drain_push(registered) -> int:
    env = registered["env"]
    auth = registered["auth"]
    ldb_conn = ldb.connect(str(registered["links_db_path"]))
    try:
        client = mc_client.McClient(base_url=env.url)
        try:
            return await mc_push.push_once(env, auth, ldb_conn, client)
        finally:
            await client.aclose()
    finally:
        ldb_conn.close()


# ── scenarios ────────────────────────────────────────────────────────


async def test_1_mc_created_task_appears_locally(
    registered, http_with_pat, kanban_home,
):
    """Operator creates a task → events deliver task.created → local row appears."""
    import hermes_cli.kanban_db as kb
    fresh = registered["fresh_org"]
    auth = registered["auth"]

    resp = await http_with_pat.post(
        f"{MC_URL}/v1/tasks",
        json={
            "project_id": fresh["project_id"],
            "title": "T from MC",
            "body": "body from MC",
            "agent_id": auth.agent_id,
        },
    )
    assert resp.status_code == 201, resp.text
    mc_task_id = resp.json()["task"]["id"]

    # Drain the pull loop
    processed = await _drain_pull(registered)
    assert processed >= 1

    ldb_conn = ldb.connect(str(registered["links_db_path"]))
    try:
        link = ldb.get_link_by_mc(ldb_conn, mc_task_id)
    finally:
        ldb_conn.close()
    assert link is not None
    assert link.source == "pulled"

    with kb.connect() as kconn:
        task = kb.get_task(kconn, link.local_task_id)
    assert task is not None
    assert task.title == "T from MC"


async def test_2_local_status_change_lands_on_mc(
    registered, http_with_pat, kanban_home,
):
    """Local dispatcher claims a task → push reactor PATCHes MC → verify."""
    import hermes_cli.kanban_db as kb
    fresh = registered["fresh_org"]
    auth = registered["auth"]

    # Operator creates a task; plugin pulls it
    resp = await http_with_pat.post(
        f"{MC_URL}/v1/tasks",
        json={"project_id": fresh["project_id"], "title": "T2", "agent_id": auth.agent_id},
    )
    mc_task_id = resp.json()["task"]["id"]
    await _drain_pull(registered)

    ldb_conn = ldb.connect(str(registered["links_db_path"]))
    try:
        link = ldb.get_link_by_mc(ldb_conn, mc_task_id)
    finally:
        ldb_conn.close()
    assert link is not None

    # Simulate the dispatcher claiming the task
    with kb.connect() as kconn:
        try:
            kb.claim_ready_task(kconn, link.local_task_id, assignee=auth.agent_id, lock_token="x", expires_in_s=60)
        except Exception:
            # Fallback if helper signature differs
            kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (link.local_task_id,))
            kconn.execute(
                "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?, 'claimed', '{}', strftime('%s', 'now'))",
                (link.local_task_id,))

    await _drain_push(registered)

    # Verify MC state
    get_resp = await http_with_pat.get(f"{MC_URL}/v1/tasks/{mc_task_id}")
    assert get_resp.json()["task"]["status"] == "in_progress"


async def test_3_mc_comment_appears_locally(
    registered, http_with_pat, kanban_home,
):
    import hermes_cli.kanban_db as kb
    fresh = registered["fresh_org"]
    auth = registered["auth"]

    # Setup: create + pull
    resp = await http_with_pat.post(
        f"{MC_URL}/v1/tasks",
        json={"project_id": fresh["project_id"], "title": "T3", "agent_id": auth.agent_id},
    )
    mc_task_id = resp.json()["task"]["id"]
    await _drain_pull(registered)

    # Operator posts a comment
    cmt_resp = await http_with_pat.post(
        f"{MC_URL}/v1/tasks/{mc_task_id}/comments",
        json={"body": "hello from operator"},
    )
    assert cmt_resp.status_code == 201, cmt_resp.text

    # Pull again — comment.created event should arrive
    await _drain_pull(registered)

    ldb_conn = ldb.connect(str(registered["links_db_path"]))
    try:
        link = ldb.get_link_by_mc(ldb_conn, mc_task_id)
    finally:
        ldb_conn.close()

    with kb.connect() as kconn:
        comments = kb.list_comments(kconn, link.local_task_id)
    bodies = [c.body for c in comments]
    authors = [c.author for c in comments]
    assert any("hello from operator" in b for b in bodies)
    assert any(a.startswith("mission-control:") for a in authors)


async def test_4_comment_on_blocked_auto_unblocks(
    registered, http_with_pat, kanban_home,
):
    import hermes_cli.kanban_db as kb
    fresh = registered["fresh_org"]
    auth = registered["auth"]

    # Setup
    resp = await http_with_pat.post(
        f"{MC_URL}/v1/tasks",
        json={"project_id": fresh["project_id"], "title": "T4", "agent_id": auth.agent_id},
    )
    mc_task_id = resp.json()["task"]["id"]
    await _drain_pull(registered)

    ldb_conn = ldb.connect(str(registered["links_db_path"]))
    try:
        link = ldb.get_link_by_mc(ldb_conn, mc_task_id)
    finally:
        ldb_conn.close()

    # Force local to blocked
    with kb.connect() as kconn:
        kconn.execute("UPDATE tasks SET status='running' WHERE id=?", (link.local_task_id,))
        kb.block_task(kconn, link.local_task_id, reason="waiting")
    # Mirror to MC (push) so the link.local_status is also blocked
    await _drain_push(registered)
    # Update the link's denorm local_status
    ldb_conn = ldb.connect(str(registered["links_db_path"]))
    try:
        ldb.update_link_state(ldb_conn, link.local_task_id, local_status="blocked")
    finally:
        ldb_conn.close()

    # Operator posts a comment on the blocked task
    await http_with_pat.post(
        f"{MC_URL}/v1/tasks/{mc_task_id}/comments",
        json={"body": "please continue, you're good"},
    )

    # Pull triggers the auto-unblock path
    await _drain_pull(registered)

    with kb.connect() as kconn:
        task = kb.get_task(kconn, link.local_task_id)
    assert task.status == "ready"


async def test_5_promote_pushes_local_task_to_mc(
    registered, http_with_pat, kanban_home,
):
    import hermes_cli.kanban_db as kb
    fresh = registered["fresh_org"]
    auth = registered["auth"]

    # Create local task (no MC link yet)
    with kb.connect() as kconn:
        local_id = kb.create_task(kconn, title="Local Origin Task", assignee=auth.agent_id)

    # Promote via the tool (sync wrapper)
    result = mc_tools.mc_promote_task(
        local_id,
        fresh["project_slug"],
        auth_path=registered["auth_path"],
        links_db_path=registered["links_db_path"],
    )
    assert "mc_task_id" in result, result
    assert result["already_linked"] is False

    # Verify MC has the task
    get_resp = await http_with_pat.get(f"{MC_URL}/v1/tasks/{result['mc_task_id']}")
    assert get_resp.json()["task"]["title"] == "Local Origin Task"


async def test_6_mc_cancelled_archives_locally(
    registered, http_with_pat, kanban_home,
):
    import hermes_cli.kanban_db as kb
    fresh = registered["fresh_org"]
    auth = registered["auth"]

    # Setup
    resp = await http_with_pat.post(
        f"{MC_URL}/v1/tasks",
        json={"project_id": fresh["project_id"], "title": "T6", "agent_id": auth.agent_id},
    )
    mc_task_id = resp.json()["task"]["id"]
    await _drain_pull(registered)

    # Operator cancels via PATCH status
    await http_with_pat.patch(
        f"{MC_URL}/v1/tasks/{mc_task_id}",
        json={"status": "cancelled"},
    )
    await _drain_pull(registered)

    ldb_conn = ldb.connect(str(registered["links_db_path"]))
    try:
        link = ldb.get_link_by_mc(ldb_conn, mc_task_id)
    finally:
        ldb_conn.close()

    with kb.connect() as kconn:
        task = kb.get_task(kconn, link.local_task_id)
    assert task.status == "archived"


async def test_7_local_comment_mirrors_and_dedupes(
    registered, http_with_pat, kanban_home,
):
    import hermes_cli.kanban_db as kb
    fresh = registered["fresh_org"]
    auth = registered["auth"]

    # Setup
    resp = await http_with_pat.post(
        f"{MC_URL}/v1/tasks",
        json={"project_id": fresh["project_id"], "title": "T7", "agent_id": auth.agent_id},
    )
    mc_task_id = resp.json()["task"]["id"]
    await _drain_pull(registered)

    ldb_conn = ldb.connect(str(registered["links_db_path"]))
    try:
        link = ldb.get_link_by_mc(ldb_conn, mc_task_id)
    finally:
        ldb_conn.close()

    # Local worker adds a comment via the normal kanban path
    with kb.connect() as kconn:
        cmt_id = kb.add_comment(kconn, link.local_task_id, auth.agent_id, "from local worker")

    # Push reactor mirrors it to MC
    await _drain_push(registered)

    # Verify MC has the comment
    cmts_resp = await http_with_pat.get(f"{MC_URL}/v1/tasks/{mc_task_id}/comments")
    bodies = [c["body"] for c in cmts_resp.json()["comments"]]
    assert "from local worker" in bodies

    # Pull again — should NOT re-add the comment locally (dedup)
    await _drain_pull(registered)
    with kb.connect() as kconn:
        comments_after_pull = kb.list_comments(kconn, link.local_task_id)
    matching = [c for c in comments_after_pull if c.body == "from local worker"]
    assert len(matching) == 1, f"expected 1 comment, got {len(matching)}"
