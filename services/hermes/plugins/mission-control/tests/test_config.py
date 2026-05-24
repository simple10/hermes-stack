"""Tests for config: env loading + auth.json read/write with mtime cache."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from mission_control import config as cfg


# ── load_env ──────────────────────────────────────────────────────────

def test_load_env_returns_none_when_url_unset(monkeypatch):
    monkeypatch.delenv("HERMES_MC_URL", raising=False)
    assert cfg.load_env() is None


def test_load_env_returns_none_when_url_empty(monkeypatch):
    monkeypatch.setenv("HERMES_MC_URL", "  ")
    assert cfg.load_env() is None


def test_load_env_defaults(monkeypatch):
    for k in ("HERMES_MC_AGENT_NAME", "HERMES_MC_BOARD",
              "HERMES_MC_POLL_INTERVAL", "HERMES_MC_DEFAULT_PROJECT_SLUG",
              "HERMES_MC_DEBUG", "HERMES_MC_USER_PAT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com/")
    e = cfg.load_env()
    assert e is not None
    assert e.url == "https://mc.example.com"   # trailing slash stripped
    assert e.board == "mc"
    assert e.poll_interval_s == 10
    assert e.debug is False
    assert e.agent_name is None
    assert e.user_pat is None
    assert e.default_project_slug is None


def test_load_env_overrides(monkeypatch):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("HERMES_MC_BOARD", "team-a")
    monkeypatch.setenv("HERMES_MC_POLL_INTERVAL", "5")
    monkeypatch.setenv("HERMES_MC_DEBUG", "true")
    monkeypatch.setenv("HERMES_MC_AGENT_NAME", "vm-prod")
    monkeypatch.setenv("HERMES_MC_DEFAULT_PROJECT_SLUG", "default-proj")
    monkeypatch.setenv("HERMES_MC_USER_PAT", "mcpat_xxx")
    e = cfg.load_env()
    assert e.board == "team-a"
    assert e.poll_interval_s == 5
    assert e.debug is True
    assert e.agent_name == "vm-prod"
    assert e.default_project_slug == "default-proj"
    assert e.user_pat == "mcpat_xxx"


def test_load_env_clamps_poll_below_2_to_2(monkeypatch):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("HERMES_MC_POLL_INTERVAL", "0")
    assert cfg.load_env().poll_interval_s == 2
    monkeypatch.setenv("HERMES_MC_POLL_INTERVAL", "1")
    assert cfg.load_env().poll_interval_s == 2


def test_load_env_invalid_poll_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("HERMES_MC_POLL_INTERVAL", "not-a-number")
    # Must not crash; falls back to 10 (or 2 — implementer's call)
    e = cfg.load_env()
    assert e.poll_interval_s >= 2


@pytest.mark.parametrize("val,expected", [
    ("true", True), ("True", True), ("TRUE", True), ("1", True),
    ("yes", True), ("on", True),
    ("false", False), ("0", False), ("", False), ("no", False),
])
def test_load_env_debug_truthy_strings(monkeypatch, val, expected):
    monkeypatch.setenv("HERMES_MC_URL", "https://mc.example.com")
    monkeypatch.setenv("HERMES_MC_DEBUG", val)
    assert cfg.load_env().debug is expected


# ── load_auth / save_auth ─────────────────────────────────────────────

def test_load_auth_returns_none_when_file_missing(tmp_path):
    cfg._reset_cache_for_tests()
    assert cfg.load_auth(tmp_path / "auth.json") is None


def test_load_auth_returns_none_when_no_mc_block(tmp_path):
    cfg._reset_cache_for_tests()
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"providers": {"other": {}}}))
    assert cfg.load_auth(p) is None


def test_load_auth_returns_none_when_agent_key_missing(tmp_path):
    """Defense: a block exists but is missing required fields."""
    cfg._reset_cache_for_tests()
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"providers": {"mission_control": {
        "url": "https://mc.example.com",
        "org_id": "org_1",
        # agent_key missing
    }}}))
    assert cfg.load_auth(p) is None


def test_load_auth_returns_block(tmp_path):
    cfg._reset_cache_for_tests()
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"providers": {"mission_control": {
        "url": "https://mc.example.com",
        "org_id": "org_1",
        "agent_id": "agt_1",
        "agent_key": "mcagt_xxx",
        "connector_id": "cnn_1",
        "connector_key": "mccnn_xxx",
        "registered_at": 12345,
    }}}))
    a = cfg.load_auth(p)
    assert a is not None
    assert a.url == "https://mc.example.com"
    assert a.org_id == "org_1"
    assert a.agent_key == "mcagt_xxx"
    assert a.connector_id == "cnn_1"
    assert a.connector_key == "mccnn_xxx"
    assert a.registered_at == 12345


def test_load_auth_caches_by_mtime(tmp_path):
    cfg._reset_cache_for_tests()
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"providers": {"mission_control": {
        "url": "https://mc.example.com", "org_id": "org_1", "agent_id": "agt_1",
        "agent_key": "mcagt_a", "connector_id": "cnn_1",
        "connector_key": "mccnn_a", "registered_at": 1,
    }}}))
    a1 = cfg.load_auth(p)
    a2 = cfg.load_auth(p)
    assert a1 is a2  # cached identity

    # Re-write with a bumped mtime; cache should re-read.
    p.write_text(json.dumps({"providers": {"mission_control": {
        "url": "https://mc.example.com", "org_id": "org_1", "agent_id": "agt_1",
        "agent_key": "mcagt_b", "connector_id": "cnn_1",
        "connector_key": "mccnn_b", "registered_at": 2,
    }}}))
    new_mtime = a1._mtime + 1.0
    os.utime(p, (new_mtime, new_mtime))
    a3 = cfg.load_auth(p)
    assert a3.agent_key == "mcagt_b"


def test_load_auth_returns_none_on_corrupt_json(tmp_path):
    cfg._reset_cache_for_tests()
    p = tmp_path / "auth.json"
    p.write_text("{ not valid json")
    assert cfg.load_auth(p) is None


def test_save_auth_roundtrip(tmp_path):
    cfg._reset_cache_for_tests()
    p = tmp_path / "subdir" / "auth.json"  # parents created
    cfg.save_auth(
        p,
        url="https://mc.example.com",
        org_id="org_1",
        agent_id="agt_1",
        agent_key="mcagt_x",
        connector_id="cnn_1",
        connector_key="mccnn_x",
    )
    a = cfg.load_auth(p)
    assert a is not None
    assert a.agent_key == "mcagt_x"
    assert a.registered_at > 0


def test_save_auth_preserves_other_providers(tmp_path):
    cfg._reset_cache_for_tests()
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"providers": {"spotify": {"token": "abc"}}}))
    cfg.save_auth(
        p,
        url="https://mc.example.com",
        org_id="org_1",
        agent_id="agt_1",
        agent_key="mcagt_x",
        connector_id="cnn_1",
        connector_key="mccnn_x",
    )
    data = json.loads(p.read_text())
    assert data["providers"]["spotify"]["token"] == "abc"
    assert data["providers"]["mission_control"]["agent_key"] == "mcagt_x"
