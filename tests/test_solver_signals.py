"""Tests for process cleanup registration."""

from __future__ import annotations

import threading
from typing import Any

import vision_ai_recaptcha_solver.solver as solver_module


def _reset_registration_state(monkeypatch: Any) -> None:
    monkeypatch.setattr(solver_module, "_atexit_registered", False)
    monkeypatch.setattr(solver_module, "_signal_handlers_registered", False)
    monkeypatch.setattr(solver_module, "_original_sigint_handler", None)
    monkeypatch.setattr(solver_module, "_original_sigterm_handler", None)


def test_worker_thread_skips_signal_registration(monkeypatch: Any) -> None:
    """Creating a solver helper in a worker must not call signal.signal()."""
    _reset_registration_state(monkeypatch)
    atexit_calls: list[Any] = []
    signal_calls: list[tuple[Any, Any]] = []
    errors: list[BaseException] = []

    monkeypatch.setattr(solver_module.atexit, "register", atexit_calls.append)
    monkeypatch.setattr(
        solver_module.signal,
        "signal",
        lambda signum, handler: signal_calls.append((signum, handler)),
    )

    def register_from_worker() -> None:
        try:
            solver_module._register_cleanup_handlers(register_signal_handlers=True)
        except BaseException as error:  # pragma: no cover - assertion reports it
            errors.append(error)

    worker = threading.Thread(target=register_from_worker)
    worker.start()
    worker.join()

    assert errors == []
    assert atexit_calls == [solver_module._cleanup_all_solvers]
    assert signal_calls == []
    assert solver_module._signal_handlers_registered is False


def test_main_thread_can_register_after_worker(monkeypatch: Any) -> None:
    """A worker call must not prevent later registration in the main thread."""
    _reset_registration_state(monkeypatch)
    signal_calls: list[tuple[Any, Any]] = []

    monkeypatch.setattr(solver_module.atexit, "register", lambda callback: None)
    monkeypatch.setattr(solver_module.signal, "getsignal", lambda signum: None)
    monkeypatch.setattr(
        solver_module.signal,
        "signal",
        lambda signum, handler: signal_calls.append((signum, handler)),
    )

    worker = threading.Thread(
        target=solver_module._register_cleanup_handlers,
        kwargs={"register_signal_handlers": True},
    )
    worker.start()
    worker.join()

    solver_module._register_cleanup_handlers(register_signal_handlers=True)

    assert signal_calls
    assert solver_module._signal_handlers_registered is True
