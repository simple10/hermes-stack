"""Test harness for the mission-control plugin.

Three responsibilities:

1. Bridge sys.path to services/hermes/_source/ so `hermes_cli.*` imports
   resolve (the source tree is a separately-cloned upstream).
2. Register the hyphenated plugin directory as the Python module
   'mission_control' (Python identifiers can't have hyphens).
3. Scrub `_HERMES_GATEWAY` and `HERMES_KANBAN_TASK` from every test's env.
   The former is set at module-import of gateway/run.py and would falsely
   trigger the gateway-loop path; the latter is set by the dispatcher
   when spawning workers.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

HERMES_SOURCE = Path(__file__).resolve().parents[3] / "_source"
PLUGIN_ROOT = Path(__file__).resolve().parents[1]

if str(HERMES_SOURCE) not in sys.path:
    sys.path.insert(0, str(HERMES_SOURCE))


def _register_plugin_as_package() -> None:
    if "mission_control" in sys.modules:
        return
    spec = importlib.util.spec_from_file_location(
        "mission_control",
        PLUGIN_ROOT / "__init__.py",
        submodule_search_locations=[str(PLUGIN_ROOT)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load mission-control plugin package")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mission_control"] = mod
    spec.loader.exec_module(mod)


_register_plugin_as_package()

import pytest


@pytest.fixture(autouse=True)
def _scrub_runtime_markers(monkeypatch):
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
