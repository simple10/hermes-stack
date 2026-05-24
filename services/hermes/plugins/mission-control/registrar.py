"""First-run registration: PAT → agent + connector keys + project cache.

Idempotent. Re-running rotates both keys instead of creating duplicate
agents/connectors. Hard-fails when MC doesn't expose POST /v1/connectors
(plugin v1 needs both keys; v1.1 may add agent-only mode).
"""
from __future__ import annotations

import json
import logging
import socket
from pathlib import Path
from typing import Optional

from . import client as mc_client
from . import config as cfg
from . import links_db as ldb

log = logging.getLogger("hermes.plugins.mission_control.registrar")

PROJECTS_CACHE_FILENAME = "projects.json"


class ConnectorRoutesUnavailable(Exception):
    """POST /v1/connectors not available in this MC deployment."""
    code = "mc.connector_routes_unavailable"

    def __init__(self, message: Optional[str] = None):
        super().__init__(message or (
            "MC deployment does not support connector minting; promotion "
            "features unavailable. Either upgrade MC to a version with "
            "POST /v1/connectors, or wait for plugin v1.1 which can run "
            "agent-only."
        ))


def _projects_cache_path(auth_path: Path) -> Path:
    return Path(auth_path).parent / "mission-control" / PROJECTS_CACHE_FILENAME


def _resolve_agent_name(env: cfg.Env, override: Optional[str]) -> str:
    if override:
        return override
    if env.agent_name:
        return env.agent_name
    return socket.gethostname()


async def _mint_or_rotate_agent(client: mc_client.McClient, pat: str, name: str) -> dict:
    """Return {'id': str, 'key': str} for this agent identity.

    Lists existing agents; if one matches `name`, rotates its key.
    Otherwise creates a new one.
    """
    listing = await client.agents_list(pat=pat)
    existing = next(
        (a for a in (listing.get("agents") or []) if a.get("name") == name),
        None,
    )
    if existing is not None:
        rot = await client.agents_rotate_key(pat=pat, agent_id=existing["id"])
        return {"id": existing["id"], "key": rot["key"]}
    created = await client.agents_create(pat=pat, name=name, kind="hermes")
    return {"id": created["agent"]["id"], "key": created["key"]}


async def _mint_or_rotate_connector(client: mc_client.McClient, pat: str, name: str) -> dict:
    """Same as _mint_or_rotate_agent but for connectors. Raises
    ConnectorRoutesUnavailable if MC doesn't expose the route."""
    try:
        listing = await client.connectors_list(pat=pat)
    except (mc_client.NotFound, mc_client.AuthFailed) as e:
        log.error("MC /v1/connectors unavailable: %s", e)
        raise ConnectorRoutesUnavailable() from e

    existing = next(
        (c for c in (listing.get("connectors") or []) if c.get("name") == name),
        None,
    )
    if existing is not None:
        try:
            rot = await client.connectors_rotate_key(pat=pat, connector_id=existing["id"])
            return {"id": existing["id"], "key": rot["key"]}
        except (mc_client.NotFound, mc_client.AuthFailed) as e:
            raise ConnectorRoutesUnavailable() from e

    try:
        created = await client.connectors_create(pat=pat, name=name, kind="hermes")
    except (mc_client.NotFound, mc_client.AuthFailed) as e:
        raise ConnectorRoutesUnavailable() from e
    return {"id": created["connector"]["id"], "key": created["key"]}


async def _cache_project_list(client: mc_client.McClient, pat: str, projects_path: Path) -> int:
    """Fetch all projects (paginating) and write to projects.json.

    Returns the count cached.
    """
    projects: list[dict] = []
    cursor: Optional[str] = None
    while True:
        resp = await client.projects_list(pat=pat, cursor=cursor)
        for p in resp.get("projects") or []:
            projects.append({
                "id": p["id"],
                "slug": p.get("slug") or "",
                "name": p.get("name") or "",
            })
        cursor = resp.get("next_cursor")
        if not cursor:
            break

    projects_path.parent.mkdir(parents=True, exist_ok=True)
    projects_path.write_text(json.dumps(projects, indent=2))
    return len(projects)


async def _init_events_cursor(
    client: mc_client.McClient,
    connector_key: str,
    ldb_conn,
) -> int:
    """Set links_db.mc_cursors.events to MC's current head id so the
    first pull cycle picks up only NEW events (not the entire history).

    Returns the head id we set (or 0 if the stream is empty).
    """
    resp = await client.events_list(
        connector_key=connector_key,
        since=0,
        kinds="task,comment,external_ref",
        limit=1,
    )
    events = resp.get("events") or []
    if not events:
        return 0
    head_id = int(events[0]["id"])
    ldb.set_cursor(ldb_conn, "events", head_id)
    return head_id


async def register(
    env: cfg.Env,
    auth_path: Path,
    links_db_path: Path,
    pat: str,
    *,
    name: Optional[str] = None,
) -> cfg.Auth:
    """Mint or rotate agent + connector keys; cache projects; init cursor.

    Idempotent. Hard-fails with ConnectorRoutesUnavailable when MC
    doesn't expose POST /v1/connectors.
    """
    resolved_name = _resolve_agent_name(env, name)
    client = mc_client.McClient(base_url=env.url)
    try:
        agent = await _mint_or_rotate_agent(client, pat, resolved_name)
        connector = await _mint_or_rotate_connector(client, pat, resolved_name)

        me = await client.me(key=agent["key"])
        org_id = (me.get("org") or {}).get("id")
        if not org_id:
            # Fall back to whatever the API gave us
            org_id = me.get("org_id") or me.get("orgId") or ""

        cfg.save_auth(
            auth_path,
            url=env.url,
            org_id=org_id,
            agent_id=agent["id"],
            agent_key=agent["key"],
            connector_id=connector["id"],
            connector_key=connector["key"],
        )

        await _cache_project_list(client, pat, _projects_cache_path(auth_path))

        ldb_conn = ldb.connect(str(links_db_path))
        try:
            await _init_events_cursor(client, connector["key"], ldb_conn)
        finally:
            ldb_conn.close()

    finally:
        await client.aclose()

    auth = cfg.load_auth(auth_path)
    if auth is None:
        raise RuntimeError("registrar: auth.json missing after save (filesystem error?)")
    return auth


async def refresh_projects(env: cfg.Env, auth_path: Path, pat: str) -> int:
    """Re-fetch the project list and rewrite the cache file. Returns the count."""
    client = mc_client.McClient(base_url=env.url)
    try:
        return await _cache_project_list(client, pat, _projects_cache_path(auth_path))
    finally:
        await client.aclose()
