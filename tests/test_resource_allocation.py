"""Tests for solver resource allocation."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from vision_ai_recaptcha_solver.config import SolverConfig
from vision_ai_recaptcha_solver.resource_allocation import (
    release_solver_resources,
    reserve_solver_resources,
)


class _DummySolver:
    pass


def test_auto_assigns_unique_defaults() -> None:
    """Implicit defaults should be auto-unique across running solvers."""
    config1 = SolverConfig()
    config2 = SolverConfig()
    solver1 = _DummySolver()
    solver2 = _DummySolver()
    logger = logging.getLogger("test_resource_allocation")

    try:
        reserve_solver_resources(solver1, config1, logger)
        reserve_solver_resources(solver2, config2, logger)

        assert config1.server_port != config2.server_port
        assert config1.download_dir != config2.download_dir
    finally:
        release_solver_resources(solver1)
        release_solver_resources(solver2)


def test_explicit_conflict_warns_and_preserves_values(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Explicit conflicts should warn and keep provided values."""
    config1 = SolverConfig(server_port=9000, download_dir=Path("explicit"))
    config2 = SolverConfig(server_port=9000, download_dir=Path("explicit"))
    solver1 = _DummySolver()
    solver2 = _DummySolver()
    logger = logging.getLogger("test_resource_allocation")

    try:
        reserve_solver_resources(solver1, config1, logger)

        with caplog.at_level(logging.WARNING, logger="test_resource_allocation"):
            reserve_solver_resources(solver2, config2, logger)

        assert config2.server_port == 9000
        assert config2.download_dir == Path("explicit")
        assert "server_port 9000 is already in use by another running solver" in caplog.text
        assert "download_dir 'explicit' is already in use by another running solver" in caplog.text
    finally:
        release_solver_resources(solver1)
        release_solver_resources(solver2)
