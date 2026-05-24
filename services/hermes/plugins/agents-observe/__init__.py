"""agents-observe — fire-and-forget observability for Hermes.

Ships every supported hook payload to an
[agents-observe](https://github.com/simple10/agents-observe) HTTP backend.
Pure observation: never mutates payloads, never blocks the agent. A missing
or hung backend is invisible to Hermes — the hot path is bounded to a
shallow dict copy and a non-blocking `Queue.put_nowait` (~µs). All
sanitization, serialization, and network I/O happen on a daemon worker
thread.

Required env (set in ``~/.hermes/.env``)::

    HERMES_AGENTS_OBSERVE_URL=http://host.docker.internal:4981

When unset the plugin is inert: ``register()`` returns immediately and no
hooks are wired, so the per-hook cost is zero.

Optional env::

    HERMES_AGENTS_OBSERVE_PROJECT_SLUG   # sets _meta.project.slug
    HERMES_AGENTS_OBSERVE_TIMEOUT_MS     # per-POST timeout (default 2000)
    HERMES_AGENTS_OBSERVE_QUEUE_SIZE     # max queued envelopes (default 1000)
    HERMES_AGENTS_OBSERVE_MAX_CHARS      # per-string cap in sanitize (default 12000)
    HERMES_AGENTS_OBSERVE_DEBUG          # true → INFO-level worker logs
"""
from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Iterable

logger = logging.getLogger(__name__)

# -- All hooks Hermes fires (see docs/specs/2026-05-21-agents-observe-plugin.md).
# Transform / gateway / pre_llm_call observers return None unconditionally so
# Hermes keeps the original value — this plugin never mutates the data flow.
_HOOKS: tuple[str, ...] = (
    "pre_tool_call",
    "post_tool_call",
    "transform_terminal_output",
    "transform_tool_result",
    "transform_llm_output",
    "pre_llm_call",
    "post_llm_call",
    "pre_api_request",
    "post_api_request",
    "on_session_start",
    "on_session_end",
    "on_session_finalize",
    "on_session_reset",
    "subagent_stop",
    "pre_gateway_dispatch",
    "pre_approval_request",
    "post_approval_response",
)

# Process-wide singleton state. `register()` is called once per plugin load;
# the worker thread is started exactly once and lives for the process.
_QUEUE: "queue.Queue[tuple[float, str, Dict[str, Any]]] | None" = None
_BASE_URL: str = ""
_PROJECT_SLUG: str = ""
_TIMEOUT_S: float = 2.0
_MAX_CHARS: int = 12000
_DEBUG: bool = False
_DROPPED: int = 0
_WORKER_STARTED: bool = False
_START_LOCK = threading.Lock()


# -- env helpers ----------------------------------------------------------


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str) -> bool:
    return _env(name).lower() in {"1", "true", "yes", "on"}


# -- sanitization (worker-side) -------------------------------------------


def _truncate(s: str, cap: int) -> str:
    if len(s) <= cap:
        return s
    return s[:cap] + f"... [truncated {len(s) - cap} chars]"


def _sanitize(value: Any, depth: int = 0) -> Any:
    """Recursively coerce ``value`` into something json.dumps can handle.

    Caps recursion depth at 6, strings at ``_MAX_CHARS``, and collections at
    200 entries. Non-primitive / non-collection objects become their type
    name in angle brackets — this matters for ``pre_gateway_dispatch``,
    which receives live MessageEvent / GatewayRunner / SessionStore
    instances that we don't want to introspect.
    """
    if depth > 6:
        return "<max-depth>"
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return _truncate(value, _MAX_CHARS)
    if isinstance(value, bytes):
        return {"_type": "bytes", "len": len(value)}
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= 200:
                out["_truncated"] = f"... {len(value) - 200} more keys"
                break
            out[str(k)] = _sanitize(v, depth + 1)
        return out
    if isinstance(value, (list, tuple, set, frozenset)):
        items = list(value)
        result = [_sanitize(v, depth + 1) for v in items[:200]]
        if len(items) > 200:
            result.append(f"... {len(items) - 200} more items")
        return result
    # Framework objects, dataclasses, custom classes — keep only the type.
    return f"<{type(value).__name__}>"


def _redact_large_images(payload: Dict[str, Any], cap: int = 4000) -> None:
    """In-place: redact base64 image blobs in Claude-style tool_response arrays.

    Hermes' generic tool layer doesn't produce these, but ``post_tool_call``
    can carry through MCP tools that mimic the Claude-Code shape — keeping
    the heuristic matches agents-observe's behavior across agent classes.
    """
    resp = payload.get("tool_response")
    if not isinstance(resp, list):
        return
    for item in resp:
        if not isinstance(item, dict):
            continue
        src = item.get("source")
        if not isinstance(src, dict) or src.get("type") != "base64":
            continue
        data = src.get("data")
        if isinstance(data, str) and len(data) > cap:
            src["data"] = "[REDACTED]"


# -- envelope -------------------------------------------------------------


def _build_envelope(ts: float, hook_name: str, kwargs: Dict[str, Any]) -> Dict[str, Any]:
    sanitized = _sanitize(kwargs)
    if isinstance(sanitized, dict):
        _redact_large_images(sanitized)

    # session_id / cwd extraction — best-effort, depends on hook shape.
    session_id = ""
    cwd: Any = None
    if isinstance(sanitized, dict):
        session_id = (
            sanitized.get("session_id")
            or sanitized.get("parent_session_id")
            or ""
        )
        cwd = sanitized.get("cwd")

    envelope: Dict[str, Any] = {
        "agentClass": "hermes",
        "sessionId": session_id,
        "agentId": session_id,
        "hookName": hook_name,
        "cwd": cwd,
        "timestamp": ts,
        "payload": sanitized,
    }
    if _PROJECT_SLUG:
        envelope["_meta"] = {"project": {"slug": _PROJECT_SLUG}}
    return envelope


# -- transport (worker-side) ----------------------------------------------


def _post(envelope: Dict[str, Any]) -> None:
    """POST ``envelope`` and discard the response. Never raises."""
    try:
        body = json.dumps(envelope, default=repr).encode("utf-8")
    except Exception as exc:  # pragma: no cover - last-resort guard
        if _DEBUG:
            logger.info("agents-observe: json encode failed: %s", exc)
        return

    req = urllib.request.Request(
        f"{_BASE_URL}/api/events",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
            # Drain a bounded chunk so the connection can close cleanly. We
            # don't care about the response body — agents-observe's callback
            # protocol is a no-op for us (pure observation).
            resp.read(1024)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        if _DEBUG:
            logger.info("agents-observe: POST failed: %s", exc)
    except Exception as exc:  # pragma: no cover - last-resort guard
        if _DEBUG:
            logger.info("agents-observe: POST error: %s", exc)


# -- worker thread --------------------------------------------------------


def _worker_loop() -> None:
    """Drain the queue, sanitize, serialize, POST. Never exits.

    Each iteration is wrapped in a broad ``try/except`` — a bad payload or a
    transient SDK quirk can never kill the worker. If the loop itself ever
    explodes (e.g. the queue is GC'd at interpreter shutdown), the daemon
    flag lets the process exit cleanly without us doing anything.
    """
    assert _QUEUE is not None
    while True:
        try:
            ts, hook_name, kwargs = _QUEUE.get()
        except Exception as exc:  # pragma: no cover - shutdown race
            if _DEBUG:
                logger.info("agents-observe: queue get failed: %s", exc)
            time.sleep(0.1)
            continue
        try:
            envelope = _build_envelope(ts, hook_name, kwargs)
            _post(envelope)
        except Exception as exc:
            if _DEBUG:
                logger.info(
                    "agents-observe: dropped %s (%s: %s)",
                    hook_name, type(exc).__name__, exc,
                )


# -- hook observers (caller-side) -----------------------------------------


def _make_observer(hook_name: str):
    """Return a hook callback that enqueues ``(ts, hook_name, kwargs)``.

    The agent thread runs this; it must do nothing slower than a shallow
    dict copy and a `put_nowait`. ``return None`` keeps transform / gateway
    hooks behaviorally invisible.
    """

    def observer(**kwargs: Any) -> None:
        global _DROPPED
        try:
            # Shallow copy so a later mutation of kwargs (Hermes reuses dicts
            # in places) can't change what we eventually serialize.
            _QUEUE.put_nowait((time.time(), hook_name, dict(kwargs)))  # type: ignore[union-attr]
        except queue.Full:
            _DROPPED += 1
            if _DEBUG and _DROPPED % 100 == 1:
                logger.info(
                    "agents-observe: queue full, dropped %d events so far",
                    _DROPPED,
                )
        except Exception as exc:  # pragma: no cover - last-resort guard
            if _DEBUG:
                logger.info("agents-observe: enqueue failed: %s", exc)
        return None

    observer.__name__ = f"observe_{hook_name}"
    return observer


# -- registration ---------------------------------------------------------


def _start_worker_once() -> None:
    global _WORKER_STARTED
    with _START_LOCK:
        if _WORKER_STARTED:
            return
        t = threading.Thread(
            target=_worker_loop,
            name="agents-observe-worker",
            daemon=True,
        )
        t.start()
        _WORKER_STARTED = True


def register(ctx) -> None:
    """Hermes plugin entry point.

    Reads config from env, starts the worker thread, and registers every
    hook in ``_HOOKS``. If ``HERMES_AGENTS_OBSERVE_URL`` is unset, returns
    immediately without registering anything — the per-hook cost is zero
    when the plugin is "off."
    """
    global _QUEUE, _BASE_URL, _PROJECT_SLUG, _TIMEOUT_S, _MAX_CHARS, _DEBUG

    base_url = _env("HERMES_AGENTS_OBSERVE_URL")
    if not base_url:
        logger.info(
            "agents-observe: HERMES_AGENTS_OBSERVE_URL not set — plugin inert"
        )
        return

    _BASE_URL = base_url.rstrip("/")
    _PROJECT_SLUG = _env("HERMES_AGENTS_OBSERVE_PROJECT_SLUG")
    _TIMEOUT_S = max(0.1, _env_int("HERMES_AGENTS_OBSERVE_TIMEOUT_MS", 2000) / 1000.0)
    _MAX_CHARS = max(256, _env_int("HERMES_AGENTS_OBSERVE_MAX_CHARS", 12000))
    _DEBUG = _env_bool("HERMES_AGENTS_OBSERVE_DEBUG")
    queue_size = max(16, _env_int("HERMES_AGENTS_OBSERVE_QUEUE_SIZE", 1000))
    _QUEUE = queue.Queue(maxsize=queue_size)

    _start_worker_once()

    registered: Iterable[str] = _HOOKS
    for hook in registered:
        ctx.register_hook(hook, _make_observer(hook))

    logger.info(
        "agents-observe: registered %d hooks -> %s (project_slug=%r, timeout=%.2fs, queue=%d)",
        len(_HOOKS), _BASE_URL, _PROJECT_SLUG or None, _TIMEOUT_S, queue_size,
    )
