"""Pull loop — subscribes to MC's GET /v1/events and dispatches each
event to apply.handle_one_event.

Single integer cursor (`mc_cursors.events` row); single endpoint; uses
the connector key (events stream requires whole-org read; agent role
is forbidden).

The loop survives transient failures via Backoff (5s → 120s). On
AuthFailed (401/403) it stops and sets status='auth_failed' — the
operator must re-register before loops resume.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from . import apply
from . import client as mc_client
from . import config as cfg
from . import links_db as ldb
from .backoff import Backoff

log = logging.getLogger("hermes.plugins.mission_control.pull")


# ── status reporting (read by dashboard / hermes mc status) ────────


_status: dict[str, Any] = {
    "status": "idle",        # 'idle' | 'running' | 'auth_failed' | 'error'
    "pull_last_success_at": None,
    "pull_last_error": None,
    "pull_consecutive_errors": 0,
    "pull_events_cursor": 0,
}


def get_pull_status() -> dict[str, Any]:
    return dict(_status)


def _set(**kw) -> None:
    _status.update(kw)


# ── single cycle ───────────────────────────────────────────────────


_KINDS = "task,comment,external_ref"
_LIMIT = 100
_APPLY_LOG_RETENTION_MS = 24 * 3600 * 1000


async def pull_once(
    env: cfg.Env,
    auth: cfg.Auth,
    ldb_conn,
    client: mc_client.McClient,
) -> int:
    """Run ONE pull cycle. Returns total events processed.

    Drains within-window pagination (follows next_cursor until empty),
    then advances the global `events` cursor to the highest id seen.

    Per-event apply errors are caught by apply.handle_one_event itself
    (so one bad event doesn't stall the loop). If an unhandled
    exception escapes, this function re-raises without advancing the
    cursor — the next cycle re-fetches starting at the same since.
    """
    cursor = ldb.get_cursor(ldb_conn, "events")
    highest = cursor
    total = 0
    next_cursor: str | None = None

    while True:
        resp = await client.events_list(
            connector_key=auth.connector_key,
            since=cursor,
            kinds=_KINDS,
            limit=_LIMIT,
            cursor=next_cursor,
        )
        events = resp.get("events") or []
        for ev in events:
            await apply.handle_one_event(ev, env, auth, client, ldb_conn)
            ev_id = int(ev.get("id") or 0)
            if ev_id > highest:
                highest = ev_id
            total += 1

        next_cursor = resp.get("next_cursor")
        if not events or not next_cursor:
            break

    if highest > cursor:
        ldb.set_cursor(ldb_conn, "events", highest)

    ldb.purge_apply_log(ldb_conn, older_than_ms=_APPLY_LOG_RETENTION_MS)

    _set(
        pull_events_cursor=highest,
        pull_last_success_at=int(time.time() * 1000),
        pull_last_error=None,
        pull_consecutive_errors=0,
        status="running",
    )
    return total


# ── long-running loop ──────────────────────────────────────────────


async def pull_loop(
    env: cfg.Env,
    auth: cfg.Auth,
    ldb_conn,
    client: mc_client.McClient,
    stop_event: asyncio.Event,
) -> None:
    """Run pull_once repeatedly until ``stop_event`` is set OR AuthFailed.

    Backoff schedule on transient errors (httpx connection/timeout/5xx):
    5s → 30s → 120s with ±25% jitter; reset on success.
    """
    backoff = Backoff(base=5.0, factor=2.0, cap=120.0, jitter=0.25)
    _set(status="running")

    while not stop_event.is_set():
        try:
            await pull_once(env, auth, ldb_conn, client)
            backoff.reset()
            await asyncio.sleep(env.poll_interval_s)
        except mc_client.AuthFailed as e:
            log.error("mc pull: auth failed (%s); stopping loop until re-registration", e)
            _set(
                status="auth_failed",
                pull_last_error=f"auth_failed: {e}",
                pull_consecutive_errors=_status["pull_consecutive_errors"] + 1,
            )
            return
        except (httpx.RequestError, httpx.HTTPStatusError, asyncio.TimeoutError) as e:
            delay = backoff.next()
            log.warning("mc pull: transient failure (%s); backing off %.1fs", e, delay)
            _set(
                status="error",
                pull_last_error=str(e),
                pull_consecutive_errors=_status["pull_consecutive_errors"] + 1,
            )
            await asyncio.sleep(delay)
        except Exception as e:
            # Last-resort guard — don't let an unanticipated exception kill the loop
            delay = backoff.next()
            log.exception("mc pull: unexpected error; backing off %.1fs", delay)
            _set(
                status="error",
                pull_last_error=f"unexpected: {e}",
                pull_consecutive_errors=_status["pull_consecutive_errors"] + 1,
            )
            await asyncio.sleep(delay)
