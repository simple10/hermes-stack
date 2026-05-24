"""hermes mc CLI subcommand surface.

Registered via ``ctx.register_cli_command(name='mc', help=..., setup_fn=setup,
handler_fn=handle)``. The setup_fn adds subparsers; the handler dispatches
by parsed args.mc_subcommand.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Optional

from . import client as mc_client
from . import config as cfg
from . import links_db as ldb
from . import registrar
from . import runtime as mc_runtime
from . import tools as mc_tools


def _default_auth_path() -> Path:
    return Path.home() / ".hermes" / "auth.json"


def _default_links_db_path() -> Path:
    return Path.home() / ".hermes" / "mission-control" / "links.db"


# ── argparse setup ──────────────────────────────────────────────────


def setup(parser: argparse.ArgumentParser) -> None:
    """Add the subparsers to ``hermes mc`` parser."""
    parser.add_argument("--auth-path", type=Path, default=None,
                        help=argparse.SUPPRESS)
    parser.add_argument("--links-db-path", type=Path, default=None,
                        help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest="mc_subcommand", required=True)

    p_register = sub.add_parser("register",
                                 help="Register this VM with MissionControl (or rotate keys).")
    p_register.add_argument("--pat",
                             help="mcpat_… personal access token (or set HERMES_MC_USER_PAT)")
    p_register.add_argument("--name",
                             help="Agent name (default: HERMES_MC_AGENT_NAME or hostname)")

    sub.add_parser("status", help="Show MissionControl connection + sync status.")

    p_refresh = sub.add_parser("refresh-projects",
                                help="Re-fetch the MC project list cache.")
    p_refresh.add_argument("--pat",
                            help="mcpat_… personal access token (or set HERMES_MC_USER_PAT)")

    p_promote = sub.add_parser("promote",
                                help="Promote a local kanban task to MissionControl.")
    p_promote.add_argument("local_task_id")
    p_promote.add_argument("--project",
                            help="MC project slug (or set HERMES_MC_DEFAULT_PROJECT_SLUG)")

    p_unlink = sub.add_parser("unlink",
                               help="Remove the MC link for a local task. MC task NOT deleted.")
    p_unlink.add_argument("local_task_id")

    sub.add_parser("test", help="Smoke-test connectivity to MC.")


def handle(args: argparse.Namespace) -> int:
    """Dispatch to the matching subcommand handler. Returns exit code."""
    auth_path = args.auth_path or _default_auth_path()
    links_db_path = args.links_db_path or _default_links_db_path()

    sub = args.mc_subcommand
    if sub == "register":
        return _cmd_register(args, auth_path, links_db_path)
    if sub == "status":
        return _cmd_status(args, auth_path, links_db_path)
    if sub == "refresh-projects":
        return _cmd_refresh_projects(args, auth_path)
    if sub == "promote":
        return _cmd_promote(args, auth_path, links_db_path)
    if sub == "unlink":
        return _cmd_unlink(args, links_db_path)
    if sub == "test":
        return _cmd_test(args, auth_path)
    print(f"unknown subcommand: {sub}", file=sys.stderr)
    return 2


# ── subcommand impls ────────────────────────────────────────────────


def _resolve_pat(args_pat: Optional[str]) -> Optional[str]:
    return args_pat or os.environ.get("HERMES_MC_USER_PAT") or None


def _cmd_register(args: argparse.Namespace, auth_path: Path, links_db_path: Path) -> int:
    env = cfg.load_env()
    if env is None:
        print("ERROR: HERMES_MC_URL is not set in env.", file=sys.stderr)
        return 2
    pat = _resolve_pat(args.pat)
    if not pat:
        print("ERROR: no PAT provided. Pass --pat mcpat_... or set HERMES_MC_USER_PAT.",
              file=sys.stderr)
        return 2
    try:
        auth = asyncio.run(registrar.register(env, auth_path, links_db_path, pat,
                                               name=args.name))
    except registrar.ConnectorRoutesUnavailable as e:
        print(f"ERROR ({e.code}): {e}", file=sys.stderr)
        return 1
    except mc_client.AuthFailed as e:
        print(f"ERROR: MC rejected the PAT (401/403): {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"ERROR: registration failed: {e}", file=sys.stderr)
        return 1

    print("Registered with MissionControl:")
    print(f"  url:           {auth.url}")
    print(f"  org_id:        {auth.org_id}")
    print(f"  agent_id:      {auth.agent_id}")
    print(f"  connector_id:  {auth.connector_id}")
    print(f"  auth.json:     {auth_path}")
    print()
    print("You can now remove HERMES_MC_USER_PAT from your .stack/.env if you set it there.")
    return 0


def _cmd_status(args: argparse.Namespace, auth_path: Path, links_db_path: Path) -> int:
    env = cfg.load_env()
    if env is None:
        print("plugin not configured (HERMES_MC_URL unset)")
        return 1
    auth = cfg.load_auth(auth_path)
    if auth is None:
        print(f"not registered (auth.json missing at {auth_path}). Run `hermes mc register`.")
        return 1

    events_cursor: Optional[int] = None
    if links_db_path.exists():
        try:
            conn = ldb.connect(str(links_db_path))
            try:
                events_cursor = ldb.get_cursor(conn, "events")
            finally:
                conn.close()
        except Exception as e:
            print(f"WARN: could not read links.db: {e}", file=sys.stderr)

    runtime_status = mc_runtime.get_status()

    print("MissionControl connection:")
    print(f"  url:           {auth.url}")
    print(f"  org_id:        {auth.org_id}")
    print(f"  agent_id:      {auth.agent_id}")
    print(f"  connector_id:  {auth.connector_id}")
    print(f"  events_cursor: {events_cursor if events_cursor is not None else '(unknown)'}")
    print(f"  loops_running: {runtime_status.get('loops_running', False)}")
    print(f"  status:        {runtime_status.get('status', 'idle')}")
    if runtime_status.get("pull_last_success_at"):
        print(f"  last pull ok:  {runtime_status['pull_last_success_at']}")
    if runtime_status.get("push_last_success_at"):
        print(f"  last push ok:  {runtime_status['push_last_success_at']}")
    pe = runtime_status.get("pull_consecutive_errors", 0)
    se = runtime_status.get("push_consecutive_errors", 0)
    print(f"  pull errors:   {pe}")
    print(f"  push errors:   {se}")
    if runtime_status.get("pull_last_error"):
        print(f"  last pull err: {runtime_status['pull_last_error']}")
    if runtime_status.get("push_last_error"):
        print(f"  last push err: {runtime_status['push_last_error']}")
    return 0


def _cmd_refresh_projects(args: argparse.Namespace, auth_path: Path) -> int:
    env = cfg.load_env()
    if env is None:
        print("ERROR: HERMES_MC_URL is not set in env.", file=sys.stderr)
        return 2
    pat = _resolve_pat(args.pat)
    if not pat:
        print("ERROR: no PAT provided. Pass --pat or set HERMES_MC_USER_PAT.",
              file=sys.stderr)
        return 2
    try:
        count = asyncio.run(registrar.refresh_projects(env, auth_path, pat))
    except Exception as e:
        print(f"ERROR: refresh-projects failed: {e}", file=sys.stderr)
        return 1
    projects_path = auth_path.parent / "mission-control" / "projects.json"
    print(f"Cached {count} project(s) to {projects_path}")
    return 0


def _cmd_promote(args: argparse.Namespace, auth_path: Path, links_db_path: Path) -> int:
    result = mc_tools.mc_promote_task(
        args.local_task_id,
        args.project,
        auth_path=auth_path,
        links_db_path=links_db_path,
    )
    if "error" in result:
        print(f"ERROR ({result.get('code', 'unknown')}): {result['error']}", file=sys.stderr)
        extras = {k: v for k, v in result.items() if k not in ("error", "code")}
        if extras:
            print(json.dumps(extras, indent=2), file=sys.stderr)
        return 1
    if result.get("already_linked"):
        print(f"Already linked: {args.local_task_id} -> {result['mc_task_id']}")
    else:
        print(f"Promoted: {args.local_task_id} -> {result['mc_task_id']}")
    return 0


def _cmd_unlink(args: argparse.Namespace, links_db_path: Path) -> int:
    if not links_db_path.exists():
        print(f"no links.db at {links_db_path} (nothing to do)")
        return 0
    conn = ldb.connect(str(links_db_path))
    try:
        existing = ldb.get_link(conn, args.local_task_id)
        ldb.delete_link(conn, args.local_task_id)
    finally:
        conn.close()
    if existing is None:
        print(f"no link for {args.local_task_id}")
    else:
        print(f"unlinked: {args.local_task_id} (was -> {existing.mc_task_id})")
    print("NOTE: MC task NOT deleted. Use the MC API directly if you want to remove it there.")
    return 0


async def _smoke_test(env: cfg.Env, auth: cfg.Auth) -> tuple[bool, list[str]]:
    """Run the 3 smoke steps. Returns (all_pass, lines_to_print)."""
    lines: list[str] = []
    all_pass = True
    client = mc_client.McClient(base_url=env.url)
    try:
        try:
            await client.me(auth.agent_key)
            lines.append("  GET /v1/me (agent key):     PASS")
        except Exception as e:
            lines.append(f"  GET /v1/me (agent key):     FAIL — {e}")
            all_pass = False

        try:
            await client.me(auth.connector_key)
            lines.append("  GET /v1/me (connector key): PASS")
        except Exception as e:
            lines.append(f"  GET /v1/me (connector key): FAIL — {e}")
            all_pass = False

        try:
            await client.events_list(
                connector_key=auth.connector_key,
                since=0,
                kinds="task,comment,external_ref",
                limit=1,
            )
            lines.append("  GET /v1/events (connector): PASS")
        except Exception as e:
            lines.append(f"  GET /v1/events (connector): FAIL — {e}")
            all_pass = False
    finally:
        await client.aclose()
    return all_pass, lines


def _cmd_test(args: argparse.Namespace, auth_path: Path) -> int:
    env = cfg.load_env()
    if env is None:
        print("plugin not configured (HERMES_MC_URL unset)")
        return 1
    auth = cfg.load_auth(auth_path)
    if auth is None:
        print(f"not registered (auth.json missing at {auth_path})")
        return 1
    print(f"MissionControl smoke test ({env.url}):")
    all_pass, lines = asyncio.run(_smoke_test(env, auth))
    for ln in lines:
        print(ln)
    return 0 if all_pass else 1
