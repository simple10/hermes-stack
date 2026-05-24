"""MC event-kind dispatch.

handle_one_event(ev, env, auth, client, ldb_conn) is called from pull.py
for every event delivered by GET /v1/events. Per-kind handlers translate
the event into local kanban writes via kanban_db helpers; the
``_apply_with_log`` wrapper captures the resulting task_events.id rows
into links_db.mc_apply_log so the push reactor skips echoes.

V1 handles: task.created, task.assigned, task.status_changed,
task.deleted, comment.created. Everything else is logged at DEBUG and
skipped (forward-compat).
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional

import hermes_cli.kanban_db as kanban_db

from . import config as cfg
from . import links_db as ldb
from . import status_map

log = logging.getLogger("hermes.plugins.mission_control.apply")


# ── _apply_with_log ─────────────────────────────────────────────────


def _apply_with_log(
    env: cfg.Env,
    ldb_conn,
    local_task_id: str,
    fn: Callable[..., Any],
    *args,
    **kwargs,
) -> Any:
    """Wrap a kanban_db mutation: capture every task_events row it emits
    for this task into mc_apply_log. The push reactor skips events
    whose id is in mc_apply_log, preventing echoes back to MC.

    Uses pre/post query on task_events filtered by task_id to find
    exactly which new event rows were inserted for this task.
    """
    with kanban_db.connect(board=env.board) as kconn:
        pre_max = kconn.execute(
            "SELECT IFNULL(MAX(id), 0) FROM task_events WHERE task_id = ?",
            (local_task_id,),
        ).fetchone()[0]
        result = fn(kconn, local_task_id, *args, **kwargs)
        new_rows = kconn.execute(
            "SELECT id FROM task_events WHERE task_id = ? AND id > ?",
            (local_task_id, pre_max),
        ).fetchall()
    for row in new_rows:
        ldb.record_apply(ldb_conn, event_id=row[0], link_id=local_task_id)
    return result


# ── per-kind handlers ───────────────────────────────────────────────


async def _handle_task_created(ev: dict, env: cfg.Env, auth: cfg.Auth, client, ldb_conn) -> None:
    task = (ev.get("payload") or {}).get("task") or {}
    mc_task_id = task.get("id") or ev.get("resource_id")
    if not mc_task_id:
        return
    if task.get("agent_id") != auth.agent_id:
        log.debug("task.created %s: not for us (agent_id=%s) — skip", mc_task_id, task.get("agent_id"))
        return
    if ldb.get_link_by_mc(ldb_conn, mc_task_id) is not None:
        log.debug("task.created %s: link already exists — idempotent skip", mc_task_id)
        return

    project_id = task.get("project_id") or "unknown"
    tenant = f"mc:{ev.get('org_id', auth.org_id)}:{project_id}"

    with kanban_db.connect(board=env.board) as kconn:
        local_task_id = kanban_db.create_task(
            kconn,
            title=task.get("title") or "(untitled MC task)",
            body=task.get("body"),
            assignee=auth.agent_id,
            tenant=tenant,
            idempotency_key=f"mc:{mc_task_id}",
        )
        # Capture all task_events rows for this new task into apply log
        new_rows = kconn.execute(
            "SELECT id FROM task_events WHERE task_id = ?",
            (local_task_id,),
        ).fetchall()
    for row in new_rows:
        ldb.record_apply(ldb_conn, event_id=row[0], link_id=local_task_id)

    ldb.insert_link(
        ldb_conn,
        local_task_id=local_task_id,
        mc_task_id=mc_task_id,
        mc_org_id=ev.get("org_id", auth.org_id),
        mc_project_id=project_id,
        mc_agent_id=task.get("agent_id"),
        source="pulled",
        local_status="ready",
        last_pulled_at=int(task.get("updated_at") or 0),
    )

    # Post external_ref to MC linking our local id (agent key)
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
    except Exception as e:
        log.warning("external_ref_create failed for %s: %s — will retry next pull", mc_task_id, e)


async def _handle_task_assigned(ev: dict, env: cfg.Env, auth: cfg.Auth, client, ldb_conn) -> None:
    payload = ev.get("payload") or {}
    to = payload.get("to")
    if to != auth.agent_id:
        log.debug("task.assigned %s: not for us (to=%s) — skip", ev.get("resource_id"), to)
        return
    mc_task_id = ev.get("resource_id")
    if not mc_task_id:
        return
    if ldb.get_link_by_mc(ldb_conn, mc_task_id) is not None:
        log.debug("task.assigned %s: link already exists — skip", mc_task_id)
        return

    # Hydrate the task via GET /v1/tasks/:id and synthesize a task.created event
    full = await client.tasks_get(key=auth.connector_key, mc_task_id=mc_task_id)
    task = full.get("task") or full   # MC envelope may be {task: {...}} or bare
    synth_ev = {
        **ev,
        "kind": "task.created",
        "payload": {"task": task},
    }
    await _handle_task_created(synth_ev, env, auth, client, ldb_conn)


async def _handle_task_status_changed(ev: dict, env: cfg.Env, auth: cfg.Auth, client, ldb_conn) -> None:
    mc_task_id = ev.get("resource_id")
    link = ldb.get_link_by_mc(ldb_conn, mc_task_id) if mc_task_id else None
    if link is None:
        log.debug("task.status_changed %s: no link — skip", mc_task_id)
        return

    payload = ev.get("payload") or {}
    to_status = payload.get("to")
    mc_task = payload.get("task") or {"status": to_status, "metadata": {}}
    mc_task.setdefault("status", to_status)
    action, extras = status_map.mc_to_local(mc_task)

    if action in ("skip", "noop"):
        log.debug("task.status_changed %s: action=%s — noop", mc_task_id, action)
        return
    if action == "block":
        _apply_with_log(
            env, ldb_conn, link.local_task_id,
            kanban_db.block_task,
            reason=extras.get("reason"),
        )
        ldb.update_link_state(
            ldb_conn, link.local_task_id,
            local_status="blocked",
            last_pulled_at=int(mc_task.get("updated_at") or 0),
        )
        return
    if action in ("complete_success", "complete_failure"):
        _apply_with_log(
            env, ldb_conn, link.local_task_id,
            kanban_db.complete_task,
            result=extras.get("result"),
            summary=extras.get("summary"),
            metadata=extras.get("metadata"),
        )
        terminal = "completed" if action == "complete_success" else "failed"
        ldb.update_link_state(
            ldb_conn, link.local_task_id,
            local_status="done",
            last_terminal_state=terminal,
            last_pulled_at=int(mc_task.get("updated_at") or 0),
        )
        return
    if action == "archive":
        _apply_with_log(
            env, ldb_conn, link.local_task_id,
            kanban_db.archive_task,
        )
        ldb.update_link_state(
            ldb_conn, link.local_task_id,
            local_status="archived",
            last_terminal_state="cancelled",
            last_pulled_at=int(mc_task.get("updated_at") or 0),
        )
        return
    # action == 'create_or_noop' for a status_changed is a noop — we don't
    # create from a status event, only from task.created/assigned.
    log.debug("task.status_changed %s: action=%s ignored", mc_task_id, action)


async def _handle_task_deleted(ev: dict, env: cfg.Env, auth: cfg.Auth, client, ldb_conn) -> None:
    mc_task_id = ev.get("resource_id")
    link = ldb.get_link_by_mc(ldb_conn, mc_task_id) if mc_task_id else None
    if link is None:
        return
    _apply_with_log(env, ldb_conn, link.local_task_id, kanban_db.archive_task)
    payload_task = (ev.get("payload") or {}).get("task") or {}
    ldb.update_link_state(
        ldb_conn, link.local_task_id,
        local_status="archived",
        last_terminal_state="cancelled",
        last_pulled_at=int(payload_task.get("updated_at") or 0),
    )


async def _handle_comment_created(ev: dict, env: cfg.Env, auth: cfg.Auth, client, ldb_conn) -> None:
    comment = (ev.get("payload") or {}).get("comment") or {}
    mc_comment_id = comment.get("id")
    parent_task_id = comment.get("task_id")
    if not mc_comment_id or not parent_task_id:
        return
    link = ldb.get_link_by_mc(ldb_conn, parent_task_id)
    if link is None:
        log.debug("comment.created on unlinked task %s — skip", parent_task_id)
        return
    if ldb.comment_has_mc(ldb_conn, mc_comment_id):
        log.debug("comment.created %s already mirrored — skip", mc_comment_id)
        return

    author_type = comment.get("author_type") or "unknown"
    author_id = comment.get("author_id") or "unknown"
    author = f"mission-control:{author_type}:{author_id}"
    body = comment.get("body") or ""

    local_comment_id = _apply_with_log(
        env, ldb_conn, link.local_task_id,
        kanban_db.add_comment,
        author, body,
    )
    ldb.insert_comment_link(
        ldb_conn,
        local_comment_id=int(local_comment_id),
        mc_comment_id=mc_comment_id,
        local_task_id=link.local_task_id,
        source="pulled",
    )

    # Auto-unblock if local was blocked
    refreshed = ldb.get_link_by_mc(ldb_conn, parent_task_id)
    if refreshed and refreshed.local_status == "blocked":
        # System annotation first
        sys_author = "mission-control:system"
        sys_body = f"auto-unblock: new comment from {author_type}"
        _apply_with_log(
            env, ldb_conn, link.local_task_id,
            kanban_db.add_comment,
            sys_author, sys_body,
        )
        _apply_with_log(
            env, ldb_conn, link.local_task_id,
            kanban_db.unblock_task,
        )
        ldb.update_link_state(
            ldb_conn, link.local_task_id,
            local_status="ready",
        )


# ── dispatch table ──────────────────────────────────────────────────


_DISPATCH = {
    "task.created":        _handle_task_created,
    "task.assigned":       _handle_task_assigned,
    "task.status_changed": _handle_task_status_changed,
    "task.deleted":        _handle_task_deleted,
    "comment.created":     _handle_comment_created,
}


async def handle_one_event(
    ev: dict,
    env: cfg.Env,
    auth: cfg.Auth,
    client,
    ldb_conn,
) -> None:
    """Dispatch a single MC event to the matching local handler.

    Unknown / v1-skipped kinds are logged at DEBUG and ignored
    (forward-compat with future MC event kinds).
    """
    kind = ev.get("kind")
    handler = _DISPATCH.get(kind)
    if handler is None:
        log.debug("event kind %r ignored in v1", kind)
        return
    try:
        await handler(ev, env, auth, client, ldb_conn)
    except Exception:
        log.exception("apply handler %s failed on event %s", kind, ev.get("id"))
        # Do NOT re-raise — one bad event shouldn't stall the loop.
