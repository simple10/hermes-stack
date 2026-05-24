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

Note: _source/ contains a top-level ``tools/`` package that collides with
the plugin's ``tools.py`` submodule.  We work around this by eagerly
pre-registering ``mission_control.tools`` in sys.modules before any test
import can resolve the name to the wrong package.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

HERMES_SOURCE = Path(__file__).resolve().parents[3] / "_source"
PLUGIN_ROOT = Path(__file__).resolve().parents[1]

if str(HERMES_SOURCE) not in sys.path:
    sys.path.insert(0, str(HERMES_SOURCE))


def _load_plugin_submodule(parent_name: str, submodule_name: str) -> None:
    """Pre-register a plugin submodule in sys.modules to prevent collisions
    with same-named top-level packages on sys.path (e.g. _source/tools/).
    """
    full_name = f"{parent_name}.{submodule_name}"
    if full_name in sys.modules:
        return
    spec = importlib.util.spec_from_file_location(
        full_name,
        PLUGIN_ROOT / f"{submodule_name}.py",
    )
    if spec is None or spec.loader is None:
        return  # submodule not present yet; skip silently
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = parent_name
    sys.modules[full_name] = mod
    spec.loader.exec_module(mod)


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
    # Pre-register submodules whose names collide with _source/ top-level packages.
    _load_plugin_submodule("mission_control", "tools")


_register_plugin_as_package()

import pytest


@pytest.fixture(autouse=True)
def _scrub_runtime_markers(monkeypatch):
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
