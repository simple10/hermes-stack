"""LLM-callable tools registered with the Hermes plugin loader.

v1: just mc_promote_task. The hermes tool interface is sync; this
module exposes a sync entry point that wraps the async client via
asyncio.run. Workers calling this from non-loop context is fine; from
inside a running loop, the tool will raise.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Optional

import hermes_cli.kanban_db as kanban_db

from . import client as mc_client
from . import config as cfg
from . import links_db as ldb
from . import registrar

log = logging.getLogger("hermes.plugins.mission_control.tools")


# Default paths — overridable via fn args in tests.
def _default_auth_path() -> Path:
    return Path.home() / ".hermes" / "auth.json"


def _default_links_db_path() -> Path:
    return Path.home() / ".hermes" / "mission-control" / "links.db"


def _projects_cache_path(auth_path: Path) -> Path:
    return Path(auth_path).parent / "mission-control" / registrar.PROJECTS_CACHE_FILENAME


def _load_projects_cache(auth_path: Path) -> list[dict]:
    p = _projects_cache_path(auth_path)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text()) or []
    except (OSError, json.JSONDecodeError):
        return []


def _resolve_project_id(auth_path: Path, slug: str) -> Optional[str]:
    for proj in _load_projects_cache(auth_path):
        if proj.get("slug") == slug:
            return proj.get("id")
    return None


# ── sync wrapper ────────────────────────────────────────────────────


def mc_promote_task(
    local_task_id: str,
    project_slug: Optional[str] = None,
    *,
    auth_path: Optional[Path] = None,
    links_db_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Sync entry point. Wraps the async impl in asyncio.run.

    Returns either:
      {"mc_task_id": str, "already_linked": bool}
    Or an error dict:
      {"error": str, "code": str, ...details}
    """
    return asyncio.run(_mc_promote_task_async(
        local_task_id,
        project_slug,
        auth_path=auth_path,
        links_db_path=links_db_path,
    ))


# ── async impl ──────────────────────────────────────────────────────


async def _mc_promote_task_async(
    local_task_id: str,
    project_slug: Optional[str] = None,
    *,
    auth_path: Optional[Path] = None,
    links_db_path: Optional[Path] = None,
) -> dict[str, Any]:
    env = cfg.load_env()
    if env is None:
        return {"error": "plugin not registered (HERMES_MC_URL unset)",
                "code": "mc.not_registered"}

    a_path = auth_path or _default_auth_path()
    auth = cfg.load_auth(a_path)
    if auth is None:
        return {"error": "plugin not registered (auth.json missing or invalid)",
                "code": "mc.not_registered"}

    slug = project_slug or env.default_project_slug
    if not slug:
        return {"error": "no project specified (and HERMES_MC_DEFAULT_PROJECT_SLUG unset)",
                "code": "mc.no_project"}

    project_id = _resolve_project_id(a_path, slug)
    if project_id is None:
        return {"error": f"unknown project slug {slug!r} — try `hermes mc refresh-projects`",
                "code": "mc.unknown_project",
                "slug": slug}

    ldb_path = links_db_path or _default_links_db_path()
    ldb_conn = ldb.connect(str(ldb_path))
    try:
        existing = ldb.get_link(ldb_conn, local_task_id)
        if existing is not None:
            return {"mc_task_id": existing.mc_task_id, "already_linked": True}

        with kanban_db.connect(board=env.board) as kconn:
            task = kanban_db.get_task(kconn, local_task_id)
        if task is None:
            return {"error": f"local kanban task {local_task_id!r} not found",
                    "code": "mc.local_task_not_found"}

        client = mc_client.McClient(base_url=env.url)
        try:
            try:
                resp = await client.tasks_create(
                    connector_key=auth.connector_key,
                    project_id=project_id,
                    title=task.title,
                    body=task.body,
                    agent_id=auth.agent_id,
                    idempotency_key=f"hermes:{local_task_id}",
                    metadata={"origin": "hermes"},
                )
                mc_task = resp.get("task") if isinstance(resp, dict) else None
                if not isinstance(mc_task, dict) or "id" not in mc_task:
                    return {"error": "MC returned no task in response",
                            "code": "mc.unexpected_response",
                            "response": resp}
                mc_task_id = mc_task["id"]
                updated_at = int(mc_task.get("updated_at") or 0)
            except mc_client.IdempotencyConflict as e:
                # Was the existing task already linked to OUR local task?
                if e.existing_task_id:
                    by_mc = ldb.get_link_by_mc(ldb_conn, e.existing_task_id)
                    if by_mc is not None and by_mc.local_task_id == local_task_id:
                        return {"mc_task_id": e.existing_task_id, "already_linked": True}
                    if by_mc is not None and by_mc.local_task_id != local_task_id:
                        log.error(
                            "idempotency conflict: hermes:%s already in use by local %s (MC=%s)",
                            local_task_id, by_mc.local_task_id, e.existing_task_id,
                        )
                        return {
                            "error": "MC idempotency key already in use by a different local task",
                            "code": "mc.idempotency_conflict_mismatch",
                            "existing_mc_task_id": e.existing_task_id,
                            "existing_local_task_id": by_mc.local_task_id,
                        }
                    # MC reports existing but we have no link — orphan reference
                    return {
                        "error": "MC reports existing task for this idempotency key but plugin has no link record",
                        "code": "mc.idempotency_conflict_orphan",
                        "existing_mc_task_id": e.existing_task_id,
                    }
                log.error("idempotency conflict without existing_task_id: %s", e.body)
                raise

            ldb.insert_link(
                ldb_conn,
                local_task_id=local_task_id,
                mc_task_id=mc_task_id,
                mc_org_id=auth.org_id,
                mc_project_id=project_id,
                mc_agent_id=auth.agent_id,
                source="pushed",
                local_status=task.status,
                last_pulled_at=updated_at,
                last_pushed_at=updated_at,
            )

            # External ref: best-effort
            try:
                await client.external_ref_create(
                    agent_key=auth.agent_key,
                    resource_type="task",
                    resource_id=mc_task_id,
                    source_kind="hermes",
                    source_id=auth.agent_id,
                    external_id=local_task_id,
                    idempotency_key=f"hermes:xrf:{local_task_id}",
                )
            except Exception as xrf_err:
                log.warning(
                    "external_ref_create failed for promoted task %s (mc=%s): %s — will retry next pull",
                    local_task_id, mc_task_id, xrf_err,
                )

            return {"mc_task_id": mc_task_id, "already_linked": False}
        finally:
            await client.aclose()
    finally:
        ldb_conn.close()
