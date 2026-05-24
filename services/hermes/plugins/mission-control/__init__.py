"""mission-control plugin entry point.

register(ctx) wires the plugin into Hermes:
  - Registers the mc_promote_task tool (LLM-callable).
  - Registers the `hermes mc` CLI subcommand.
  - Starts the pull+push runtime thread IFF we're in the gateway process
    AND a registered auth.json exists.

Tool + CLI register unconditionally so worker subprocesses (which load
the plugin too) can call mc_promote_task and `hermes mc promote`.
Loops only start in the gateway to avoid duplicate polling and confused
state across processes.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from . import cli
from . import config
from . import runtime
from . import tools

log = logging.getLogger("hermes.plugins.mission_control")


# ── path helpers ────────────────────────────────────────────────────


def _auth_path() -> Path:
    return Path.home() / ".hermes" / "auth.json"


def _links_db_path() -> Path:
    return Path.home() / ".hermes" / "mission-control" / "links.db"


# ── gateway detection ──────────────────────────────────────────────


def _is_gateway() -> bool:
    """Reuse existing _HERMES_GATEWAY=1 marker (set at module-import of
    gateway/run.py); negative HERMES_KANBAN_TASK excludes workers
    (which inherit the gateway's env)."""
    return (
        os.environ.get("_HERMES_GATEWAY") == "1"
        and not os.environ.get("HERMES_KANBAN_TASK")
    )


# ── tool wrapper ───────────────────────────────────────────────────


def _tool_handler(args: dict[str, Any], **_kw) -> str:
    """Wrap mc_promote_task for Hermes' tool-dispatch protocol.

    Returns a JSON-string envelope so tool output can flow back to the
    LLM verbatim.
    """
    local_task_id = args.get("local_task_id")
    project_slug = args.get("project_slug")
    if not local_task_id:
        return json.dumps({"error": "local_task_id is required",
                           "code": "mc.bad_args"})
    result = tools.mc_promote_task(local_task_id, project_slug)
    return json.dumps(result)


_TOOL_SCHEMA: dict[str, Any] = {
    "name": "mc_promote_task",
    "description": (
        "Promote an existing local kanban task to MissionControl so the "
        "human can see/comment on it from Notion or the MC UI. Returns "
        "the MC task id. If the task is already promoted, returns the "
        "existing mc_task_id (idempotent)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "local_task_id": {
                "type": "string",
                "description": "id of the local kanban task",
            },
            "project_slug": {
                "type": "string",
                "description": "MC project slug (omit to use HERMES_MC_DEFAULT_PROJECT_SLUG)",
            },
        },
        "required": ["local_task_id"],
    },
}


# ── loop startup ───────────────────────────────────────────────────


def _maybe_start_loops() -> bool:
    """Start the runtime daemon thread iff env + auth + gateway-detection."""
    if not _is_gateway():
        log.debug("mission-control: not in gateway process; loops not started")
        return False
    env = config.load_env()
    if env is None:
        log.debug("mission-control: HERMES_MC_URL unset; loops not started")
        return False
    auth = config.load_auth(_auth_path())
    if auth is None:
        log.info("mission-control: not registered (auth.json missing); loops not started")
        return False
    runtime.start(env, auth, str(_links_db_path()))
    log.info(
        "mission-control: loops started for org=%s agent=%s",
        auth.org_id, auth.agent_id,
    )
    return True


# ── plugin entry ───────────────────────────────────────────────────


def register(ctx) -> None:
    """Hermes plugin entry point."""
    # 1. Tool — unconditional, so workers can call it.
    try:
        ctx.register_tool(
            name="mc_promote_task",
            toolset="mission-control",
            schema=_TOOL_SCHEMA,
            handler=_tool_handler,
            description="Promote a local kanban task to MissionControl.",
            emoji="☁️",
        )
    except Exception as e:
        log.warning("mission-control: tool registration failed: %s", e)

    # 2. CLI — unconditional, so operators can register / status from anywhere.
    try:
        ctx.register_cli_command(
            name="mc",
            help="MissionControl integration",
            setup_fn=cli.setup,
            handler_fn=cli.handle,
            description="Subcommands: register, status, refresh-projects, promote, unlink, test",
        )
    except Exception as e:
        log.warning("mission-control: CLI registration failed: %s", e)

    # 3. Loops — gated on gateway detection + valid auth.
    _maybe_start_loops()
