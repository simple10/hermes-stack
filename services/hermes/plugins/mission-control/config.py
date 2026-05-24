"""Plugin config — env vars + ~/.hermes/auth.json.

Env vars carry the HERMES_MC_ prefix all the way into the VM (no rename
in the managed .env block). auth.json read is cached by mtime so worker
subprocesses don't hit disk on every plugin discovery.
"""
from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class Env:
    url: str
    user_pat: Optional[str]
    agent_name: Optional[str]
    board: str
    poll_interval_s: int
    default_project_slug: Optional[str]
    debug: bool


@dataclass
class Auth:
    url: str
    org_id: str
    agent_id: str
    agent_key: str
    connector_id: str
    connector_key: str
    registered_at: int
    _mtime: float = field(default=0.0, repr=False, compare=False)


_TRUTHY = {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in _TRUTHY


def _env_str(name: str) -> Optional[str]:
    v = os.environ.get(name, "").strip()
    return v or None


def load_env() -> Optional[Env]:
    """Return an Env if HERMES_MC_URL is set; else None (plugin inert)."""
    url = os.environ.get("HERMES_MC_URL", "").strip()
    if not url:
        return None
    poll = _env_int("HERMES_MC_POLL_INTERVAL", 10)
    return Env(
        url=url.rstrip("/"),
        user_pat=_env_str("HERMES_MC_USER_PAT"),
        agent_name=_env_str("HERMES_MC_AGENT_NAME"),
        board=os.environ.get("HERMES_MC_BOARD", "mc").strip() or "mc",
        poll_interval_s=max(2, poll),
        default_project_slug=_env_str("HERMES_MC_DEFAULT_PROJECT_SLUG"),
        debug=_env_bool("HERMES_MC_DEBUG"),
    )


# ── auth.json mtime-cache ────────────────────────────────────────────


_cache_lock = threading.Lock()
_cache: dict[str, Auth] = {}


def _reset_cache_for_tests() -> None:
    with _cache_lock:
        _cache.clear()


def load_auth(path: Path | str) -> Optional[Auth]:
    """Read the mission_control provider block from auth.json.

    Returns None when the file is missing, corrupt, or lacks a valid
    block (specifically: missing agent_key is treated as not-registered).
    Caches by mtime so repeated calls within a process are cheap.
    """
    p = Path(path)
    if not p.exists():
        return None
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return None

    key = str(p)
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None and cached._mtime == mtime:
            return cached

    try:
        data = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    block = (data.get("providers") or {}).get("mission_control")
    if not isinstance(block, dict) or not block.get("agent_key"):
        return None
    try:
        auth = Auth(
            url=block["url"],
            org_id=block["org_id"],
            agent_id=block["agent_id"],
            agent_key=block["agent_key"],
            connector_id=block["connector_id"],
            connector_key=block["connector_key"],
            registered_at=int(block.get("registered_at", 0) or 0),
            _mtime=mtime,
        )
    except KeyError:
        return None
    with _cache_lock:
        _cache[key] = auth
    return auth


def save_auth(
    path: Path | str,
    *,
    url: str,
    org_id: str,
    agent_id: str,
    agent_key: str,
    connector_id: str,
    connector_key: str,
) -> None:
    """Write the mission_control provider block to auth.json.

    Creates parent dirs as needed. Preserves any other top-level
    ``providers`` entries (e.g. spotify, github). Invalidates the
    mtime-cache so the next ``load_auth`` re-reads.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    data: dict = {}
    if p.exists():
        try:
            data = json.loads(p.read_text())
            if not isinstance(data, dict):
                data = {}
        except (OSError, json.JSONDecodeError):
            data = {}
    providers = data.setdefault("providers", {})
    if not isinstance(providers, dict):
        providers = {}
        data["providers"] = providers
    providers["mission_control"] = {
        "url": url,
        "org_id": org_id,
        "agent_id": agent_id,
        "agent_key": agent_key,
        "connector_id": connector_id,
        "connector_key": connector_key,
        "registered_at": int(time.time() * 1000),
    }
    p.write_text(json.dumps(data, indent=2))
    _reset_cache_for_tests()
