"""Smoke test for the test harness — imports work end-to-end."""
from __future__ import annotations


def test_plugin_package_imports():
    import mission_control  # noqa: F401


def test_hermes_source_imports():
    """conftest.py wires sys.path so hermes_cli is importable."""
    from hermes_cli import kanban_db  # noqa: F401


def test_register_is_callable():
    import mission_control as mc
    assert callable(mc.register)
    assert mc.register(ctx=None) is None
