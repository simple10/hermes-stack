"""Tests for the local↔MC status mapping (single source of truth)."""
from __future__ import annotations

import pytest

from mission_control import status_map as sm


# ── local → MC ────────────────────────────────────────────────────────

@pytest.mark.parametrize("local,expected_mc,expected_meta_keys", [
    ("ready",     "ready",       []),
    ("running",   "in_progress", []),
    ("blocked",   "blocked",     ["block_reason"]),
    ("review",    "in_progress", ["review_pending"]),
    ("scheduled", "ready",       ["scheduled_for"]),
    ("archived",  "cancelled",   []),
])
def test_local_to_mc_basic(local, expected_mc, expected_meta_keys):
    mc_status, meta = sm.local_to_mc(local, terminal_state=None, kanban_task={
        "status": local,
        "result": None,
        "metadata": {"block_reason": "x", "scheduled_for": "2026-01-01T00:00:00Z"},
    })
    assert mc_status == expected_mc
    for k in expected_meta_keys:
        assert k in meta


def test_local_to_mc_done_uses_terminal_state():
    # done + terminal_state='completed' → MC completed
    mc_status, _ = sm.local_to_mc("done", terminal_state="completed", kanban_task={
        "status": "done", "result": "ok", "metadata": {},
    })
    assert mc_status == "completed"

    # done + terminal_state='failed' → MC failed
    mc_status, meta = sm.local_to_mc("done", terminal_state="failed", kanban_task={
        "status": "done", "result": "boom", "metadata": {},
    })
    assert mc_status == "failed"
    assert "failure_reason" in meta

    # done + terminal_state=None (e.g. completed via dispatcher with no link record yet)
    # defaults to 'completed' — link.last_terminal_state should be set
    # post-push to avoid this ambiguity, but the function must be safe.
    mc_status, _ = sm.local_to_mc("done", terminal_state=None, kanban_task={
        "status": "done", "result": "ok", "metadata": {},
    })
    assert mc_status == "completed"


def test_local_to_mc_skips_unsync_states():
    # triage / pre-promotion → no push
    assert sm.local_to_mc("triage", terminal_state=None, kanban_task={"status": "triage"})[0] is None


# ── MC → local ────────────────────────────────────────────────────────

@pytest.mark.parametrize("mc_status,expected_action", [
    ("ready",       "create_or_noop"),
    ("in_progress", "noop"),
    ("blocked",     "block"),
    ("completed",   "complete_success"),
    ("failed",      "complete_failure"),
    ("cancelled",   "archive"),
    ("pending",     "skip"),
])
def test_mc_to_local_action(mc_status, expected_action):
    action, extras = sm.mc_to_local({"status": mc_status, "metadata": {}})
    assert action == expected_action


def test_mc_to_local_complete_failure_carries_reason():
    action, extras = sm.mc_to_local({
        "status": "failed",
        "metadata": {"failure_reason": "boom"},
    })
    assert action == "complete_failure"
    assert "boom" in extras.get("result", "")
    assert extras.get("metadata", {}).get("mc_failure_reason") == "boom"


def test_mc_to_local_block_carries_reason():
    action, extras = sm.mc_to_local({
        "status": "blocked",
        "metadata": {"block_reason": "needs human review"},
    })
    assert action == "block"
    assert extras.get("reason") == "needs human review"


def test_mc_to_local_unknown_status_skips():
    action, _ = sm.mc_to_local({"status": "unknown_future_status", "metadata": {}})
    assert action == "skip"


# ── kanban event-kind → MC PATCH ──────────────────────────────────────

@pytest.mark.parametrize("event_kind,run_outcome,expected_mc_status", [
    ("claimed",                 None,           "in_progress"),
    ("blocked",                 None,           "blocked"),
    ("unblocked",               None,           "ready"),
    ("archived",                None,           "cancelled"),
    ("scheduled",               None,           "ready"),
    ("completed",               "completed",    "completed"),
    ("completed",               "crashed",      "failed"),
    ("completed",               "timed_out",    "failed"),
    ("completed",               "spawn_failed", "failed"),
    ("completed",               "gave_up",      "failed"),
    ("completed",               "reclaimed",    "failed"),
    ("completed",               "blocked",      "failed"),
    ("completion_blocked_hallucination", None,  "failed"),
])
def test_event_kind_to_patch(event_kind, run_outcome, expected_mc_status):
    result = sm.event_kind_to_patch(event_kind, run_outcome=run_outcome, event_payload={})
    assert result is not None
    assert result["status"] == expected_mc_status


def test_event_kind_to_patch_returns_none_for_unhandled():
    for kind in ("assigned", "promoted", "spawned", "commented"):
        assert sm.event_kind_to_patch(kind, run_outcome=None, event_payload={}) is None


def test_event_kind_to_patch_blocked_carries_reason():
    result = sm.event_kind_to_patch("blocked", run_outcome=None, event_payload={"reason": "review-required"})
    assert result["status"] == "blocked"
    assert result["metadata"]["block_reason"] == "review-required"


def test_event_kind_to_patch_completed_failure_carries_reason():
    result = sm.event_kind_to_patch("completed", run_outcome="crashed", event_payload={"error": "OOM"})
    assert result["status"] == "failed"
    assert "OOM" in result["metadata"]["failure_reason"]


def test_event_kind_to_patch_scheduled_carries_when():
    result = sm.event_kind_to_patch("scheduled", run_outcome=None, event_payload={"scheduled_for": "2026-06-01T10:00:00Z"})
    assert result["status"] == "ready"
    assert result["metadata"]["scheduled_for"] == "2026-06-01T10:00:00Z"
