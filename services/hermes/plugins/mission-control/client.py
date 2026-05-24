"""httpx-based async client for the MissionControl HTTP API.

Each endpoint method is a thin wrapper around _request, which centralizes
auth-header injection, error-to-exception mapping, and JSON envelope
handling. Per-endpoint envelope keys (e.g. 'tasks' vs 'events') are NOT
normalized — callers see MC's actual shape.
"""
from __future__ import annotations

import httpx
from typing import Any, Optional


class AuthFailed(Exception):
    """401 / 403 from MC. Triggers loop shutdown until re-registration."""


class IdempotencyConflict(Exception):
    """409 with error.code='idempotency.conflict'.

    Carries `existing_task_id` (and the full body) when MC supplied them
    in `error.details`.
    """
    def __init__(
        self,
        existing_task_id: Optional[str] = None,
        body: Optional[dict] = None,
    ):
        self.existing_task_id = existing_task_id
        self.body = body or {}
        super().__init__(
            f"idempotency conflict (existing_task_id={existing_task_id})"
        )


class StateMachineConflict(Exception):
    """Any non-idempotency 409 (e.g. task.invalid_transition,
    agent.has_active_tasks)."""


class NotFound(Exception):
    """404 — typically means the MC resource was deleted upstream."""


class McClient:
    """Async HTTP client over httpx. One per process is sufficient.

    Caller is responsible for `await client.aclose()` when shutting down
    the loop (the runtime daemon-thread does this in its finally clause).
    """

    def __init__(self, base_url: str, timeout_s: float = 10.0):
        self._base = base_url.rstrip("/")
        self._timeout = timeout_s
        self._client = httpx.AsyncClient(timeout=timeout_s)

    async def aclose(self) -> None:
        await self._client.aclose()

    # ── HTTP helper ────────────────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        key: str,
        params: Optional[dict] = None,
        json_body: Optional[dict] = None,
        headers: Optional[dict] = None,
    ) -> dict:
        h = {"Authorization": f"Bearer {key}"}
        if headers:
            h.update(headers)
        resp = await self._client.request(
            method, f"{self._base}{path}",
            params=params, json=json_body, headers=h,
        )
        if resp.status_code in (401, 403):
            raise AuthFailed(f"{resp.status_code} {resp.text}")
        if resp.status_code == 404:
            raise NotFound(resp.text)
        if resp.status_code == 409:
            try:
                body = resp.json()
            except Exception:
                body = {}
            err = body.get("error", {}) if isinstance(body, dict) else {}
            if err.get("code") == "idempotency.conflict":
                raise IdempotencyConflict(
                    existing_task_id=(err.get("details") or {}).get("existing_task_id"),
                    body=body,
                )
            raise StateMachineConflict(str(body))
        # 5xx and any other unexpected status → raise httpx error
        if resp.status_code >= 400:
            resp.raise_for_status()
        return resp.json() if resp.content else {}

    # ── /v1/me ────────────────────────────────────────────────────

    async def me(self, key: str) -> dict:
        return await self._request("GET", "/v1/me", key=key)

    # ── /v1/events ────────────────────────────────────────────────

    async def events_list(
        self,
        *,
        connector_key: str,
        since: int = 0,
        kinds: Optional[str] = None,
        limit: int = 100,
        cursor: Optional[str] = None,
        order: Optional[str] = None,
    ) -> dict:
        """GET /v1/events. `kinds` is a comma-separated string of
        resource_type values (e.g. 'task,comment,external_ref').

        `order='desc'` returns rows in reverse-id order — used by the
        registrar to look up the current head of the stream without
        replaying history. Default (omitted) is ASC pagination.
        """
        params: dict[str, Any] = {"since": since, "limit": limit}
        if kinds is not None:
            params["kinds"] = kinds
        if cursor is not None:
            params["cursor"] = cursor
        if order is not None:
            params["order"] = order
        return await self._request(
            "GET", "/v1/events",
            key=connector_key, params=params,
        )

    # ── /v1/tasks ─────────────────────────────────────────────────

    async def tasks_list(
        self,
        *,
        agent_key: str,
        agent_id: Optional[str] = None,
        updated_since: Optional[int] = None,
        cursor: Optional[str] = None,
        limit: int = 100,
        status: Optional[str] = None,
    ) -> dict:
        params: dict[str, Any] = {"limit": limit}
        if agent_id is not None:
            params["agent_id"] = agent_id
        if updated_since is not None:
            params["updated_since"] = updated_since
        if cursor is not None:
            params["cursor"] = cursor
        if status is not None:
            params["status"] = status
        return await self._request(
            "GET", "/v1/tasks",
            key=agent_key, params=params,
        )

    async def tasks_get(self, *, key: str, mc_task_id: str) -> dict:
        return await self._request(
            "GET", f"/v1/tasks/{mc_task_id}", key=key,
        )

    async def tasks_create(
        self,
        *,
        connector_key: str,
        project_id: str,
        title: str,
        body: Optional[str] = None,
        agent_id: Optional[str] = None,
        metadata: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict:
        body_json: dict[str, Any] = {"project_id": project_id, "title": title}
        if body is not None:
            body_json["body"] = body
        if agent_id is not None:
            body_json["agent_id"] = agent_id
        if metadata is not None:
            body_json["metadata"] = metadata
        if idempotency_key is not None:
            body_json["idempotency_key"] = idempotency_key
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return await self._request(
            "POST", "/v1/tasks",
            key=connector_key, json_body=body_json, headers=headers,
        )

    async def tasks_patch(
        self,
        *,
        agent_key: str,
        mc_task_id: str,
        status: Optional[str] = None,
        metadata: Optional[dict] = None,
        title: Optional[str] = None,
        body: Optional[str] = None,
    ) -> dict:
        body_json: dict[str, Any] = {}
        if status is not None:
            body_json["status"] = status
        if metadata is not None:
            body_json["metadata"] = metadata
        if title is not None:
            body_json["title"] = title
        if body is not None:
            body_json["body"] = body
        return await self._request(
            "PATCH", f"/v1/tasks/{mc_task_id}",
            key=agent_key, json_body=body_json,
        )

    # ── /v1/tasks/:id/comments ────────────────────────────────────

    async def task_comment_create(
        self,
        *,
        key: str,
        mc_task_id: str,
        body: str,
        idempotency_key: Optional[str] = None,
    ) -> dict:
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return await self._request(
            "POST", f"/v1/tasks/{mc_task_id}/comments",
            key=key, json_body={"body": body}, headers=headers,
        )

    # ── /v1/external_refs ─────────────────────────────────────────

    async def external_ref_create(
        self,
        *,
        agent_key: str,
        resource_type: str,
        resource_id: str,
        source_kind: str,
        source_id: str,
        external_id: str,
        external_url: Optional[str] = None,
        metadata: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict:
        body: dict[str, Any] = {
            "resource_type": resource_type,
            "resource_id": resource_id,
            "source_kind": source_kind,
            "source_id": source_id,
            "external_id": external_id,
        }
        if external_url is not None:
            body["external_url"] = external_url
        if metadata is not None:
            body["metadata"] = metadata
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return await self._request(
            "POST", "/v1/external_refs",
            key=agent_key, json_body=body, headers=headers,
        )

    # ── /v1/agents ────────────────────────────────────────────────

    async def agents_list(self, *, pat: str) -> dict:
        return await self._request("GET", "/v1/agents", key=pat)

    async def agents_create(
        self,
        *,
        pat: str,
        name: str,
        kind: str,
        description: Optional[str] = None,
    ) -> dict:
        body: dict[str, Any] = {"name": name, "kind": kind}
        if description is not None:
            body["description"] = description
        return await self._request(
            "POST", "/v1/agents", key=pat, json_body=body,
        )

    async def agents_rotate_key(self, *, pat: str, agent_id: str) -> dict:
        return await self._request(
            "POST", f"/v1/agents/{agent_id}/rotate-key", key=pat,
        )

    # ── /v1/connectors ────────────────────────────────────────────

    async def connectors_list(self, *, pat: str) -> dict:
        return await self._request("GET", "/v1/connectors", key=pat)

    async def connectors_create(
        self,
        *,
        pat: str,
        name: str,
        kind: str,
        description: Optional[str] = None,
    ) -> dict:
        body: dict[str, Any] = {"name": name, "kind": kind}
        if description is not None:
            body["description"] = description
        return await self._request(
            "POST", "/v1/connectors", key=pat, json_body=body,
        )

    async def connectors_rotate_key(
        self, *, pat: str, connector_id: str,
    ) -> dict:
        return await self._request(
            "POST", f"/v1/connectors/{connector_id}/rotate-key", key=pat,
        )

    # ── /v1/projects ──────────────────────────────────────────────

    async def projects_list(
        self,
        *,
        pat: str,
        cursor: Optional[str] = None,
        limit: int = 100,
    ) -> dict:
        params: dict[str, Any] = {"limit": limit}
        if cursor is not None:
            params["cursor"] = cursor
        return await self._request(
            "GET", "/v1/projects", key=pat, params=params,
        )
