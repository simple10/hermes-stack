"""Local kanban ↔ MissionControl status mapping. Single source of truth.

This module is pure functions — no I/O, no globals (beyond constants).
All state-shape decisions live here so callers in apply.py / push.py
can stay narrowly focused on coordination.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

LocalStatus = str       # 'triage'|'todo'|'scheduled'|'ready'|'running'|'blocked'|'review'|'done'|'archived'
McStatus = str          # 'pending'|'ready'|'in_progress'|'blocked'|'completed'|'failed'|'cancelled'
TerminalState = Literal["completed", "failed", "cancelled"]
McAction = Literal[
    "create_or_noop",
    "noop",
    "block",
    "complete_success",
    "complete_failure",
    "archive",
    "skip",
]


# ── local → MC ────────────────────────────────────────────────────────

def local_to_mc(
    local_status: LocalStatus,
    *,
    terminal_state: Optional[TerminalState],
    kanban_task: dict[str, Any],
) -> tuple[Optional[McStatus], dict[str, Any]]:
    """Map a local kanban task's state to (mc_status, metadata_patch).

    Returns (None, {}) when the state shouldn't be pushed at all (e.g.
    triage, or todo with unfulfilled parents).

    ``terminal_state`` is the link's recorded ``last_terminal_state``
    column — the source of truth for done-success vs done-failure (the
    local ``result`` string is too fragile to parse). When None, defaults
    to 'completed' for done tasks; callers should set last_terminal_state
    explicitly after pushing a terminal transition.
    """
    md = kanban_task.get("metadata") or {}

    if local_status == "triage":
        return None, {}
    if local_status == "todo":
        # We don't track parent-readiness here; caller passes only ready-to-push tasks.
        return "pending", {}
    if local_status == "ready":
        return "ready", {}
    if local_status == "scheduled":
        return "ready", {"scheduled_for": md.get("scheduled_for")}
    if local_status == "running":
        return "in_progress", {}
    if local_status == "blocked":
        return "blocked", {"block_reason": md.get("block_reason")}
    if local_status == "review":
        return "in_progress", {"review_pending": True}
    if local_status == "archived":
        return "cancelled", _meta_keep(md, ["cancellation_reason"])
    if local_status == "done":
        if terminal_state == "failed":
            return "failed", {"failure_reason": _failure_reason_from(kanban_task)}
        # 'completed' or None default → MC completed
        return "completed", {}
    return None, {}


def _failure_reason_from(task: dict[str, Any]) -> str:
    md = task.get("metadata") or {}
    return (
        md.get("mc_failure_reason")
        or task.get("last_failure_error")
        or task.get("result")
        or "unknown"
    )


def _meta_keep(md: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    return {k: md[k] for k in keys if k in md and md[k] is not None}


# ── MC → local ────────────────────────────────────────────────────────

def mc_to_local(mc_task: dict[str, Any]) -> tuple[McAction, dict[str, Any]]:
    """Decide what local-side action to take for an incoming MC task state.

    Returns (action, extras) where ``extras`` carries kwargs the caller
    will forward to the kanban_db helper (e.g. ``reason`` for block,
    ``result``/``summary``/``metadata`` for complete).

    Unknown MC statuses (forward-compat) return ('skip', {}).
    """
    s = mc_task.get("status")
    md = mc_task.get("metadata") or {}
    if s == "pending":
        return "skip", {}
    if s == "ready":
        return "create_or_noop", {}
    if s == "in_progress":
        return "noop", {}
    if s == "blocked":
        return "block", {"reason": md.get("block_reason") or "blocked via mc"}
    if s == "completed":
        return "complete_success", {
            "result": "completed via mc",
            "summary": "completed via mc",
            "metadata": {"mc_terminal": "completed"},
        }
    if s == "failed":
        reason = md.get("failure_reason") or "unknown"
        return "complete_failure", {
            "result": f"failed via mc: {reason}",
            "summary": f"failed via mc: {reason}",
            "metadata": {"mc_terminal": "failed", "mc_failure_reason": reason},
        }
    if s == "cancelled":
        return "archive", {}
    # Unknown MC status — caller logs at DEBUG, skip
    return "skip", {}


# ── kanban event-kind → MC PATCH body ─────────────────────────────────

# task_runs.outcome enum: completed | blocked | crashed | timed_out |
# spawn_failed | gave_up | reclaimed | NULL. Only 'completed' maps to
# MC success; everything else is a failure.
_SUCCESSFUL_OUTCOMES = {"completed"}


def event_kind_to_patch(
    kind: str,
    *,
    run_outcome: Optional[str],
    event_payload: dict[str, Any],
) -> Optional[dict[str, Any]]:
    """Translate a kanban task_events kind into an MC PATCH body.

    Returns None when the event should not produce a PATCH (e.g.
    'commented' is handled by the comment-push path; 'assigned' /
    'promoted' / 'spawned' are local-only details).
    """
    if kind == "claimed":
        return {"status": "in_progress"}
    if kind == "blocked":
        return {
            "status": "blocked",
            "metadata": {"block_reason": event_payload.get("reason")},
        }
    if kind == "unblocked":
        return {"status": "ready"}
    if kind == "archived":
        return {"status": "cancelled"}
    if kind == "scheduled":
        return {
            "status": "ready",
            "metadata": {"scheduled_for": event_payload.get("scheduled_for")},
        }
    if kind == "completed":
        if run_outcome in _SUCCESSFUL_OUTCOMES:
            return {"status": "completed"}
        return {
            "status": "failed",
            "metadata": {
                "failure_reason": (
                    event_payload.get("error")
                    or f"kanban outcome: {run_outcome}"
                ),
            },
        }
    if kind == "completion_blocked_hallucination":
        return {
            "status": "failed",
            "metadata": {"failure_reason": "hallucinated subtask references; see kanban logs"},
        }
    return None
