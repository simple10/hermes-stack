"""Push reactor — tails local kanban task_events and PATCHes / POSTs back to MC.

Tails the events stream of the MC-pinned kanban board (env.board) on a 1s
SQLite poll. Skips events recorded in mc_apply_log (echoes of our own
pull-applies) and events for tasks without an mc_links row.

Per-event dispatch:
  status events (claimed/blocked/unblocked/archived/scheduled/completed/
    completion_blocked_hallucination) → PATCH MC. 'completed' looks up
    task_runs.outcome via kanban_db.latest_run to disambiguate success
    vs failure.
  commented → POST /v1/tasks/:id/comments with hermes:cmt:<local_id>
    idempotency key, AFTER dedup checks (mc_comment_links + author-
    prefix 'mission-control:').
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Optional

import httpx

import hermes_cli.kanban_db as kanban_db

from . import client as mc_client
from . import config as cfg
from . import links_db as ldb
from . import status_map
from .backoff import Backoff

log = logging.getLogger("hermes.plugins.mission_control.push")


_PUSH_INTERVAL_S = 1.0
_LIMIT = 200
_AUTHOR_PREFIX = "mission-control:"


# ── status reporting ──────────────────────────────────────────────


_status: dict[str, Any] = {
    "status": "idle",        # 'idle' | 'running' | 'auth_failed' | 'error'
    "push_last_success_at": None,
    "push_last_error": None,
    "push_consecutive_errors": 0,
    "push_kanban_events_cursor": 0,
}


def get_push_status() -> dict[str, Any]:
    return dict(_status)


def _set(**kw) -> None:
    _status.update(kw)


# ── helpers ───────────────────────────────────────────────────────


def _parse_payload(raw: Any) -> dict:
    if raw is None or raw == "":
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _find_local_comment_id(kconn, ldb_conn, task_id: str) -> Optional[int]:
    """Find the local comment id for a 'commented' event we're processing.

    The kanban_db 'commented' event payload doesn't carry the comment_id
    directly. Strategy: return the highest comment id for this task that
    isn't already in mc_comment_links. Safe because we process events
    in id-order and write rates are bounded.

    Known limitation: if 20+ comments are written between push cycles
    (effectively impossible in an agent workflow with 1s poll), the
    LIMIT 20 could miss some. Not worth the added complexity.
    """
    rows = kconn.execute(
        "SELECT id FROM task_comments WHERE task_id = ? ORDER BY id DESC LIMIT 20",
        (task_id,),
    ).fetchall()
    for r in rows:
        if not ldb.comment_has_local(ldb_conn, int(r["id"])):
            return int(r["id"])
    return None


def _get_comment_body_and_author(kconn, comment_id: int) -> tuple[str, str]:
    r = kconn.execute(
        "SELECT body, author FROM task_comments WHERE id = ?",
        (comment_id,),
    ).fetchone()
    if r is None:
        return "", ""
    return r["body"] or "", r["author"] or ""


def _archive_and_drop_link(env: cfg.Env, ldb_conn, link) -> None:
    """Handle MC 404 on push: archive the local task + drop the link."""
    with kanban_db.connect(board=env.board) as kconn:
        try:
            kanban_db.archive_task(kconn, link.local_task_id)
        except Exception as e:
            log.warning("failed to archive %s after MC 404: %s", link.local_task_id, e)
        try:
            kanban_db.add_comment(
                kconn, link.local_task_id, _AUTHOR_PREFIX + "system",
                "MC task no longer accessible (404 on push); link removed.",
            )
        except Exception:
            pass
    ldb.delete_link(ldb_conn, link.local_task_id)


# ── per-event dispatch ────────────────────────────────────────────


async def _handle_kanban_event(
    link,
    row,
    env: cfg.Env,
    auth: cfg.Auth,
    client: mc_client.McClient,
    kconn,
    ldb_conn,
) -> None:
    kind = row["kind"]
    payload = _parse_payload(row["payload"])

    if kind == "commented":
        local_cmt_id = _find_local_comment_id(kconn, ldb_conn, link.local_task_id)
        if local_cmt_id is None:
            return
        body, author = _get_comment_body_and_author(kconn, local_cmt_id)
        # Author-prefix defense: skip pulled-from-MC comments
        if author.startswith(_AUTHOR_PREFIX):
            return
        # Primary dedup: already in mc_comment_links
        if ldb.comment_has_local(ldb_conn, local_cmt_id):
            return
        try:
            resp = await client.task_comment_create(
                key=auth.agent_key,
                mc_task_id=link.mc_task_id,
                body=body,
                idempotency_key=f"hermes:cmt:{local_cmt_id}",
            )
            mc_comment = (resp.get("comment") or resp) if isinstance(resp, dict) else {}
            mc_comment_id = mc_comment.get("id") if isinstance(mc_comment, dict) else None
            if mc_comment_id:
                ldb.insert_comment_link(
                    ldb_conn,
                    local_comment_id=local_cmt_id,
                    mc_comment_id=mc_comment_id,
                    local_task_id=link.local_task_id,
                    source="pushed",
                )
        except mc_client.NotFound:
            _archive_and_drop_link(env, ldb_conn, link)
        except mc_client.IdempotencyConflict as e:
            log.info(
                "comment push idempotency conflict for %s (existing=%s); treating as already mirrored",
                link.local_task_id, e.existing_task_id,
            )
        return

    # Status events
    run_outcome: Optional[str] = None
    if kind == "completed":
        try:
            run = kanban_db.latest_run(kconn, link.local_task_id)
            run_outcome = getattr(run, "outcome", None) if run is not None else None
        except Exception as e:
            log.warning("latest_run lookup failed for %s: %s", link.local_task_id, e)

    body = status_map.event_kind_to_patch(kind, run_outcome=run_outcome, event_payload=payload)
    if body is None:
        return  # no-op kind (assigned/promoted/spawned/etc.)

    try:
        resp = await client.tasks_patch(
            agent_key=auth.agent_key,
            mc_task_id=link.mc_task_id,
            status=body.get("status"),
            metadata=body.get("metadata"),
        )
        # Update link.last_pushed_at + terminal state if applicable
        task = resp.get("task") if isinstance(resp, dict) else None
        if isinstance(task, dict) and task.get("updated_at") is not None:
            ldb.update_link_state(
                ldb_conn, link.local_task_id,
                last_pushed_at=int(task["updated_at"]),
            )
        mc_status = body.get("status")
        if mc_status == "completed":
            ldb.update_link_state(
                ldb_conn, link.local_task_id,
                last_terminal_state="completed",
            )
        elif mc_status == "failed":
            ldb.update_link_state(
                ldb_conn, link.local_task_id,
                last_terminal_state="failed",
            )
        elif mc_status == "cancelled":
            ldb.update_link_state(
                ldb_conn, link.local_task_id,
                last_terminal_state="cancelled",
            )
    except mc_client.NotFound:
        _archive_and_drop_link(env, ldb_conn, link)
    except mc_client.StateMachineConflict as e:
        log.warning(
            "push state-machine conflict for %s kind=%s; pull will reconcile: %s",
            link.local_task_id, kind, e,
        )


# ── single cycle ──────────────────────────────────────────────────


async def push_once(
    env: cfg.Env,
    auth: cfg.Auth,
    ldb_conn,
    client: mc_client.McClient,
) -> int:
    """Run ONE push cycle. Returns rows examined (some may have been skipped)."""
    last_event_id = ldb.get_cursor(ldb_conn, "kanban_events")

    with kanban_db.connect(board=env.board) as kconn:
        rows = kconn.execute(
            "SELECT id, task_id, kind, payload, run_id, created_at "
            "FROM task_events WHERE id > ? ORDER BY id ASC LIMIT ?",
            (last_event_id, _LIMIT),
        ).fetchall()

        for r in rows:
            last_event_id = int(r["id"])

            if ldb.is_in_apply_log(ldb_conn, last_event_id):
                continue
            link = ldb.get_link(ldb_conn, r["task_id"])
            if link is None:
                continue
            await _handle_kanban_event(link, r, env, auth, client, kconn, ldb_conn)

    ldb.set_cursor(ldb_conn, "kanban_events", last_event_id)
    _set(
        push_kanban_events_cursor=last_event_id,
        push_last_success_at=int(time.time() * 1000),
        push_last_error=None,
        push_consecutive_errors=0,
        status="running",
    )
    return len(rows)


# ── long-running loop ─────────────────────────────────────────────


async def push_loop(
    env: cfg.Env,
    auth: cfg.Auth,
    ldb_conn,
    client: mc_client.McClient,
    stop_event: asyncio.Event,
) -> None:
    backoff = Backoff(base=5.0, factor=2.0, cap=60.0, jitter=0.25)
    _set(status="running")

    while not stop_event.is_set():
        try:
            await push_once(env, auth, ldb_conn, client)
            backoff.reset()
            await asyncio.sleep(_PUSH_INTERVAL_S)
        except mc_client.AuthFailed as e:
            log.error("mc push: auth failed (%s); stopping loop until re-registration", e)
            _set(
                status="auth_failed",
                push_last_error=f"auth_failed: {e}",
                push_consecutive_errors=_status["push_consecutive_errors"] + 1,
            )
            return
        except (httpx.RequestError, httpx.HTTPStatusError, asyncio.TimeoutError) as e:
            delay = backoff.next()
            log.warning("mc push: transient failure (%s); backing off %.1fs", e, delay)
            _set(
                status="error",
                push_last_error=str(e),
                push_consecutive_errors=_status["push_consecutive_errors"] + 1,
            )
            await asyncio.sleep(delay)
        except Exception as e:
            delay = backoff.next()
            log.exception("mc push: unexpected error; backing off %.1fs", delay)
            _set(
                status="error",
                push_last_error=f"unexpected: {e}",
                push_consecutive_errors=_status["push_consecutive_errors"] + 1,
            )
            await asyncio.sleep(delay)
