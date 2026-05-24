"""Dashboard plugin API — exposes mission-control's runtime status.

v1 ships only the API endpoint. The React widget bundle is deferred to
v1.1 once the upstream dashboard plugin-bundle pipeline is documented.
Operators can get the same info via `hermes mc status` on the CLI.

Mounted by the Hermes dashboard at /api/plugins/mission-control/.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter

try:
    from mission_control import config as cfg
    from mission_control import links_db as ldb
    from mission_control import runtime as mc_runtime
except ImportError:
    import importlib
    cfg = importlib.import_module("mission_control.config")
    ldb = importlib.import_module("mission_control.links_db")
    mc_runtime = importlib.import_module("mission_control.runtime")

log = logging.getLogger("hermes.plugins.mission_control.dashboard")


def _default_auth_path() -> Path:
    return Path.home() / ".hermes" / "auth.json"


def _default_links_db_path() -> Path:
    return Path.home() / ".hermes" / "mission-control" / "links.db"


router = APIRouter()


def _build_status(
    auth_path: Optional[Path] = None,
    links_db_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Assemble the status response. Pulled out as a free function so
    tests can call it directly without going through HTTP."""
    auth_path = auth_path or _default_auth_path()
    links_db_path = links_db_path or _default_links_db_path()

    env = cfg.load_env()
    auth = cfg.load_auth(auth_path)
    runtime_status = mc_runtime.get_status()

    base: dict[str, Any] = {
        "registered": auth is not None,
        "url": auth.url if auth else (env.url if env else None),
        "org_id": auth.org_id if auth else None,
        "agent_id": auth.agent_id if auth else None,
        "connector_id": auth.connector_id if auth else None,
        "loops_running": runtime_status.get("loops_running", False),
        "status": runtime_status.get("status", "idle"),
        "events_cursor": int(runtime_status.get("pull_events_cursor", 0) or 0),
        "kanban_events_cursor": int(runtime_status.get("push_kanban_events_cursor", 0) or 0),
        "last_pull_ok_at": runtime_status.get("pull_last_success_at"),
        "last_push_ok_at": runtime_status.get("push_last_success_at"),
        "consecutive_pull_errors": int(runtime_status.get("pull_consecutive_errors", 0) or 0),
        "consecutive_push_errors": int(runtime_status.get("push_consecutive_errors", 0) or 0),
        "last_pull_error": runtime_status.get("pull_last_error"),
        "last_push_error": runtime_status.get("push_last_error"),
        "started_at": runtime_status.get("started_at"),
        "last_thread_error": runtime_status.get("last_thread_error"),
        "links_total": 0,
        "links_dirty": 0,
        "comments_linked": 0,
    }

    try:
        if Path(links_db_path).exists():
            conn = ldb.connect(str(links_db_path))
            try:
                row = conn.execute("SELECT COUNT(*) FROM mc_links").fetchone()
                base["links_total"] = int(row[0]) if row else 0
                row = conn.execute(
                    "SELECT COUNT(*) FROM mc_links WHERE push_dirty = 1"
                ).fetchone()
                base["links_dirty"] = int(row[0]) if row else 0
                row = conn.execute("SELECT COUNT(*) FROM mc_comment_links").fetchone()
                base["comments_linked"] = int(row[0]) if row else 0
            finally:
                conn.close()
    except Exception as e:
        log.warning("dashboard: failed to read counts from links.db: %s", e)

    return base


@router.get("/status")
async def status() -> dict[str, Any]:
    """Read-only status endpoint."""
    return _build_status()
