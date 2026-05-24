"""Runtime — daemon thread that owns the pull + push asyncio loops.

Hermes' plugin discovery is sync (no asyncio event loop running when
``register(ctx)`` is called), so the pull/push loops can't simply
``asyncio.create_task`` onto an existing loop. Instead, we spawn a
single daemon thread that runs its own ``asyncio.run`` loop. The
daemon=True flag means the thread is abandoned at process exit
without blocking shutdown — both loops are sleep-bound between cycles
and hold no resources that need explicit cleanup at process exit
beyond what GC handles.

For tests, ``stop()`` cleanly tears down the thread.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Optional

from . import client as mc_client
from . import config as cfg
from . import links_db as ldb
from . import pull as mc_pull
from . import push as mc_push

log = logging.getLogger("hermes.plugins.mission_control.runtime")


# Module-level state (single thread per process; gateway is one process).
_thread: Optional[threading.Thread] = None
_stop_event: Optional[asyncio.Event] = None
_status: dict[str, Any] = {
    "loops_running": False,
    "started_at": None,
    "last_thread_error": None,
}
_state_lock = threading.Lock()


def get_status() -> dict[str, Any]:
    """Return the current runtime + pull + push status as a single dict."""
    with _state_lock:
        merged = dict(_status)
    merged.update(mc_pull.get_pull_status())
    merged.update(mc_push.get_push_status())
    return merged


def start(env: cfg.Env, auth: cfg.Auth, links_db_path: str) -> None:
    """Idempotently start the daemon thread.

    Safe to call multiple times — subsequent calls while a thread is
    alive are no-ops.
    """
    global _thread, _stop_event
    with _state_lock:
        if _thread is not None and _thread.is_alive():
            log.debug("runtime.start: thread already running — no-op")
            return
        _stop_event = None  # will be created inside the loop's thread
        _thread = threading.Thread(
            target=_thread_main,
            args=(env, auth, links_db_path),
            name="mission-control-runtime",
            daemon=True,
        )
        _status["loops_running"] = True
        _status["started_at"] = int(time.time() * 1000)
        _status["last_thread_error"] = None
        _thread.start()


def stop(join_timeout_s: float = 1.0) -> None:
    """Signal the daemon thread to stop and (briefly) wait for it.

    Mostly for tests. Production never calls this — the thread is daemon,
    so it dies at process exit.
    """
    global _thread, _stop_event
    if _stop_event is not None:
        # asyncio.Event.set() is not threadsafe — must call from the thread's
        # loop. Use call_soon_threadsafe if we have access to the loop.
        try:
            loop = getattr(_stop_event, "_loop", None)
            if loop is not None and loop.is_running():
                loop.call_soon_threadsafe(_stop_event.set)
            else:
                _stop_event.set()
        except Exception:
            pass

    if _thread is not None:
        _thread.join(timeout=join_timeout_s)
        if _thread.is_alive():
            log.warning("runtime.stop: thread did not exit within %.1fs", join_timeout_s)

    with _state_lock:
        _status["loops_running"] = False


def _thread_main(env: cfg.Env, auth: cfg.Auth, links_db_path: str) -> None:
    """Thread entry. Runs the asyncio loop until stop_event is set."""
    try:
        asyncio.run(_run_loops(env, auth, links_db_path))
    except Exception as e:
        log.exception("runtime: thread main crashed: %s", e)
        with _state_lock:
            _status["last_thread_error"] = str(e)
            _status["loops_running"] = False
    else:
        with _state_lock:
            _status["loops_running"] = False


async def _run_loops(env: cfg.Env, auth: cfg.Auth, links_db_path: str) -> None:
    """Coroutine that owns the resource lifecycle + gathers both loops.

    The sqlite3 connection is single-threaded (default check_same_thread=True)
    but both loops run as coroutines on this thread's event loop, so they
    share the connection safely.

    The McClient holds an httpx.AsyncClient bound to this loop; close it
    cleanly in the finally so the underlying transport is released.
    """
    global _stop_event
    _stop_event = asyncio.Event()
    ldb_conn = ldb.connect(links_db_path)
    client = mc_client.McClient(base_url=env.url)
    try:
        await asyncio.gather(
            mc_pull.pull_loop(env, auth, ldb_conn, client, _stop_event),
            mc_push.push_loop(env, auth, ldb_conn, client, _stop_event),
        )
    finally:
        try:
            await client.aclose()
        except Exception:
            pass
        try:
            ldb_conn.close()
        except Exception:
            pass


def _reset_for_tests() -> None:
    """Test-only: clear module state."""
    global _thread, _stop_event
    with _state_lock:
        _thread = None
        _stop_event = None
        _status["loops_running"] = False
        _status["started_at"] = None
        _status["last_thread_error"] = None
