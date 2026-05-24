"""Tests for the MC HTTP client (httpx + respx_mock)."""
from __future__ import annotations

import httpx
import pytest

from mission_control import client as mc_client


BASE = "https://mc.example.com"


def _make_client():
    return mc_client.McClient(base_url=BASE, timeout_s=2.0)


# ── /v1/me ───────────────────────────────────────────────────────────

async def test_me_with_key(respx_mock):
    route = respx_mock.get(f"{BASE}/v1/me").mock(
        return_value=httpx.Response(200, json={"org": {"id": "org_1"},
                                                "principal_type": "agent",
                                                "principal_id": "agt_1"}))
    c = _make_client()
    result = await c.me("mcagt_xxx")
    assert result["principal_id"] == "agt_1"
    assert route.called
    assert route.calls.last.request.headers["authorization"] == "Bearer mcagt_xxx"


async def test_401_raises_auth_failed(respx_mock):
    respx_mock.get(f"{BASE}/v1/me").mock(
        return_value=httpx.Response(401, json={"error": {"code": "auth.invalid"}}))
    c = _make_client()
    with pytest.raises(mc_client.AuthFailed):
        await c.me("mcagt_bad")


async def test_403_raises_auth_failed(respx_mock):
    respx_mock.get(f"{BASE}/v1/me").mock(
        return_value=httpx.Response(403, json={"error": {"code": "auth.role_insufficient"}}))
    c = _make_client()
    with pytest.raises(mc_client.AuthFailed):
        await c.me("mcagt_wrongrole")


async def test_5xx_raises_httpx_error(respx_mock):
    respx_mock.get(f"{BASE}/v1/me").mock(return_value=httpx.Response(503))
    c = _make_client()
    with pytest.raises(httpx.HTTPStatusError):
        await c.me("mcagt_x")


async def test_404_raises_notfound(respx_mock):
    respx_mock.get(f"{BASE}/v1/tasks/t_missing").mock(return_value=httpx.Response(404))
    c = _make_client()
    with pytest.raises(mc_client.NotFound):
        await c.tasks_get(key="mcagt_x", mc_task_id="t_missing")


# ── /v1/events ───────────────────────────────────────────────────────

async def test_events_list_basic(respx_mock):
    respx_mock.get(f"{BASE}/v1/events").mock(
        return_value=httpx.Response(200, json={
            "events": [{"id": 1, "kind": "task.created"}],
            "next_cursor": "abc",
        }))
    c = _make_client()
    r = await c.events_list(connector_key="mccnn_x", since=0, kinds="task,comment", limit=100)
    assert r["events"][0]["id"] == 1
    assert r["next_cursor"] == "abc"


async def test_events_list_passes_params(respx_mock):
    respx_mock.get(f"{BASE}/v1/events").mock(
        return_value=httpx.Response(200, json={"events": [], "next_cursor": None}))
    c = _make_client()
    await c.events_list(connector_key="mccnn_x", since=42,
                         kinds="task,comment,external_ref",
                         limit=50, cursor="prev")
    call = respx_mock.calls.last.request
    assert "since=42" in str(call.url)
    assert "limit=50" in str(call.url)
    assert "cursor=prev" in str(call.url)
    # kinds may be comma-encoded
    assert "kinds=" in str(call.url)
    assert "task" in str(call.url)


async def test_events_list_omits_optional_params(respx_mock):
    respx_mock.get(f"{BASE}/v1/events").mock(
        return_value=httpx.Response(200, json={"events": [], "next_cursor": None}))
    c = _make_client()
    await c.events_list(connector_key="mccnn_x", since=0)
    url = str(respx_mock.calls.last.request.url)
    assert "kinds=" not in url
    assert "cursor=" not in url


# ── /v1/tasks ────────────────────────────────────────────────────────

async def test_tasks_list_passes_filters(respx_mock):
    respx_mock.get(f"{BASE}/v1/tasks").mock(
        return_value=httpx.Response(200, json={"tasks": [], "next_cursor": "abc"}))
    c = _make_client()
    result = await c.tasks_list(agent_key="mcagt_x", agent_id="agt_1",
                                 updated_since=12345, limit=100)
    call = respx_mock.calls.last.request
    assert "agent_id=agt_1" in str(call.url)
    assert "updated_since=12345" in str(call.url)
    # MC returns 'tasks' envelope (not normalized to 'data')
    assert result["tasks"] == []
    assert result["next_cursor"] == "abc"


async def test_tasks_get(respx_mock):
    respx_mock.get(f"{BASE}/v1/tasks/t_1").mock(
        return_value=httpx.Response(200, json={"task": {"id": "t_1", "status": "ready"}}))
    c = _make_client()
    r = await c.tasks_get(key="mcagt_x", mc_task_id="t_1")
    assert r["task"]["id"] == "t_1"


async def test_tasks_create_idempotency_header(respx_mock):
    respx_mock.post(f"{BASE}/v1/tasks").mock(
        return_value=httpx.Response(201, json={"task": {"id": "t_new", "updated_at": 999}}))
    c = _make_client()
    result = await c.tasks_create(connector_key="mccnn_x",
                                   project_id="prj_1", title="t",
                                   agent_id="agt_1",
                                   idempotency_key="hermes:abc",
                                   metadata={"origin": "hermes"})
    call = respx_mock.calls.last.request
    assert call.headers["idempotency-key"] == "hermes:abc"
    assert result["task"]["id"] == "t_new"


async def test_tasks_create_body_includes_idempotency_key(respx_mock):
    respx_mock.post(f"{BASE}/v1/tasks").mock(
        return_value=httpx.Response(201, json={"task": {"id": "t_new"}}))
    c = _make_client()
    await c.tasks_create(connector_key="mccnn_x",
                          project_id="prj_1", title="t",
                          idempotency_key="hermes:abc")
    import json as _json
    body = _json.loads(respx_mock.calls.last.request.content)
    assert body["idempotency_key"] == "hermes:abc"


async def test_tasks_patch(respx_mock):
    respx_mock.patch(f"{BASE}/v1/tasks/t_1").mock(
        return_value=httpx.Response(200, json={"task": {"id": "t_1", "updated_at": 1000}}))
    c = _make_client()
    result = await c.tasks_patch(agent_key="mcagt_x", mc_task_id="t_1",
                                  status="in_progress", metadata={"k": "v"})
    assert result["task"]["updated_at"] == 1000


async def test_409_with_existing_id_surfaces_in_error(respx_mock):
    respx_mock.post(f"{BASE}/v1/tasks").mock(
        return_value=httpx.Response(409, json={"error": {
            "code": "idempotency.conflict",
            "details": {"existing_task_id": "t_dupe"},
        }}))
    c = _make_client()
    with pytest.raises(mc_client.IdempotencyConflict) as exc:
        await c.tasks_create(connector_key="mccnn_x", project_id="p",
                              title="t", agent_id="a", idempotency_key="hermes:x",
                              metadata={})
    assert exc.value.existing_task_id == "t_dupe"


async def test_409_state_machine_raises_distinct(respx_mock):
    respx_mock.patch(f"{BASE}/v1/tasks/t_1").mock(
        return_value=httpx.Response(409, json={"error": {
            "code": "task.invalid_transition",
            "details": {"from": "completed", "to": "in_progress"},
        }}))
    c = _make_client()
    with pytest.raises(mc_client.StateMachineConflict):
        await c.tasks_patch(agent_key="mcagt_x", mc_task_id="t_1", status="in_progress")


# ── /v1/tasks/:id/comments ───────────────────────────────────────────

async def test_comment_create_idempotency_header(respx_mock):
    respx_mock.post(f"{BASE}/v1/tasks/t_1/comments").mock(
        return_value=httpx.Response(201, json={"comment": {"id": "cmt_1"}}))
    c = _make_client()
    r = await c.task_comment_create(key="mcagt_x", mc_task_id="t_1",
                                     body="hi",
                                     idempotency_key="hermes:cmt:42")
    call = respx_mock.calls.last.request
    assert call.headers["idempotency-key"] == "hermes:cmt:42"
    assert r["comment"]["id"] == "cmt_1"


# ── /v1/external_refs ────────────────────────────────────────────────

async def test_external_ref_create_idempotency_header(respx_mock):
    respx_mock.post(f"{BASE}/v1/external_refs").mock(
        return_value=httpx.Response(201, json={"external_ref": {"id": "xrf_1"}}))
    c = _make_client()
    r = await c.external_ref_create(agent_key="mcagt_x",
                                     resource_type="task", resource_id="t_1",
                                     source_kind="hermes", source_id="agt_1",
                                     external_id="local_abc",
                                     idempotency_key="hermes:xrf:local_abc")
    call = respx_mock.calls.last.request
    assert call.headers["idempotency-key"] == "hermes:xrf:local_abc"
    assert r["external_ref"]["id"] == "xrf_1"


# ── /v1/agents + /v1/connectors ──────────────────────────────────────

async def test_agents_create_returns_id_and_key(respx_mock):
    respx_mock.post(f"{BASE}/v1/agents").mock(
        return_value=httpx.Response(201, json={
            "agent": {"id": "agt_new"},
            "key": "mcagt_secret",
        }))
    c = _make_client()
    r = await c.agents_create(pat="mcpat_x", name="vm1", kind="hermes")
    assert r["agent"]["id"] == "agt_new"
    assert r["key"] == "mcagt_secret"


async def test_agents_list(respx_mock):
    respx_mock.get(f"{BASE}/v1/agents").mock(
        return_value=httpx.Response(200, json={"agents": [{"id": "agt_1", "name": "vm1"}],
                                                "next_cursor": None}))
    c = _make_client()
    r = await c.agents_list(pat="mcpat_x")
    assert len(r["agents"]) == 1


async def test_agents_rotate_key(respx_mock):
    respx_mock.post(f"{BASE}/v1/agents/agt_1/rotate-key").mock(
        return_value=httpx.Response(200, json={"key": "mcagt_new"}))
    c = _make_client()
    r = await c.agents_rotate_key(pat="mcpat_x", agent_id="agt_1")
    assert r["key"] == "mcagt_new"


async def test_connectors_create_returns_id_and_key(respx_mock):
    respx_mock.post(f"{BASE}/v1/connectors").mock(
        return_value=httpx.Response(201, json={
            "connector": {"id": "cnn_new"},
            "key": "mccnn_secret",
        }))
    c = _make_client()
    r = await c.connectors_create(pat="mcpat_x", name="vm1", kind="hermes")
    assert r["connector"]["id"] == "cnn_new"


async def test_connectors_list(respx_mock):
    respx_mock.get(f"{BASE}/v1/connectors").mock(
        return_value=httpx.Response(200, json={"connectors": [],
                                                "next_cursor": None}))
    c = _make_client()
    r = await c.connectors_list(pat="mcpat_x")
    assert r["connectors"] == []


async def test_connectors_rotate_key(respx_mock):
    respx_mock.post(f"{BASE}/v1/connectors/cnn_1/rotate-key").mock(
        return_value=httpx.Response(200, json={"key": "mccnn_new"}))
    c = _make_client()
    r = await c.connectors_rotate_key(pat="mcpat_x", connector_id="cnn_1")
    assert r["key"] == "mccnn_new"


# ── /v1/projects ─────────────────────────────────────────────────────

async def test_projects_list_returns_data(respx_mock):
    respx_mock.get(f"{BASE}/v1/projects").mock(
        return_value=httpx.Response(200, json={"projects": [{"id": "prj_1", "slug": "p", "name": "P"}],
                                                "next_cursor": "tip"}))
    c = _make_client()
    r = await c.projects_list(pat="mcpat_x")
    assert len(r["projects"]) == 1
    assert r["projects"][0]["slug"] == "p"
