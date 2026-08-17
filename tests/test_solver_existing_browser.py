"""Tests for solving with an externally managed browser."""

from __future__ import annotations

from typing import Any

import vision_ai_recaptcha_solver.solver as solver_module
from vision_ai_recaptcha_solver.solver import RecaptchaSolver


def test_solve_browser_skips_initial_checkbox(monkeypatch: Any) -> None:
    """An existing challenge must not trigger another checkbox click."""
    solver = RecaptchaSolver.__new__(RecaptchaSolver)
    solver._closed = False
    browser = object()
    expected_result = object()
    received: dict[str, Any] = {}

    def fake_solve_browser_session(
        current_browser: Any,
        **kwargs: Any,
    ) -> Any:
        received["browser"] = current_browser
        received.update(kwargs)
        return expected_result

    monkeypatch.setattr(solver, "_solve_browser_session", fake_solve_browser_session)

    result = solver.solve_browser(browser)

    assert result is expected_result
    assert received["browser"] is browser
    assert received["click_checkbox_first"] is False
    assert received["complete_on_url_change"] is True


def test_solve_browser_can_enable_initial_checkbox(monkeypatch: Any) -> None:
    """The caller can request an initial checkbox click for an existing browser."""
    solver = RecaptchaSolver.__new__(RecaptchaSolver)
    solver._closed = False
    browser = object()
    received: dict[str, Any] = {}

    def fake_solve_browser_session(
        current_browser: Any,
        **kwargs: Any,
    ) -> str:
        received["browser"] = current_browser
        received.update(kwargs)
        return "result"

    monkeypatch.setattr(solver, "_solve_browser_session", fake_solve_browser_session)

    result = solver.solve_browser(browser, click_checkbox_first=True)

    assert result == "result"
    assert received["browser"] is browser
    assert received["click_checkbox_first"] is True


def test_existing_challenge_flow_does_not_click_checkbox(monkeypatch: Any) -> None:
    """The shared solve flow goes directly to the active image challenge."""
    solver = RecaptchaSolver.__new__(RecaptchaSolver)
    solver.config = type(
        "Config",
        (),
        {"default_timeout": 1.0, "max_attempts": 2},
    )()
    solver.logger = type(
        "Logger",
        (),
        {"debug": lambda *args: None, "info": lambda *args: None},
    )()
    solver._detector = type(
        "Detector",
        (),
        {"ensure_warmup_complete": lambda self: None},
    )()
    solve_calls: list[int] = []
    token_reads = iter((None, None, "token"))

    monkeypatch.setattr(solver_module, "human_delay", lambda **kwargs: None)
    monkeypatch.setattr(solver_module, "get_challenge_iframe", lambda *args, **kwargs: object())
    monkeypatch.setattr(solver_module, "is_solved", lambda *args, **kwargs: False)
    monkeypatch.setattr(
        solver_module,
        "click_checkbox",
        lambda browser: (_ for _ in ()).throw(AssertionError("checkbox must not be clicked")),
    )
    monkeypatch.setattr(solver_module, "click_verify_button", lambda browser: True)
    monkeypatch.setattr(
        solver_module,
        "wait_for_verify_result",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("same-URL external flow must continue directly")
        ),
    )
    monkeypatch.setattr(solver, "_get_browser_url", lambda browser: "https://example.com/old")
    monkeypatch.setattr(solver, "_wait_for_url_change", lambda *args, **kwargs: False)
    monkeypatch.setattr(solver, "_read_browser_token", lambda browser: next(token_reads))
    monkeypatch.setattr(solver, "_determine_captcha_type", lambda browser: object())
    monkeypatch.setattr(solver, "_get_target_class", lambda browser: 1)
    monkeypatch.setattr(
        solver,
        "_get_handler",
        lambda captcha_type: type(
            "Handler",
            (),
            {"solve": lambda self, browser, target: solve_calls.append(target) or [1]},
        )(),
    )
    monkeypatch.setattr(solver, "_build_result", lambda *args, **kwargs: "result")

    result = solver._solve_browser_session(
        object(),
        token_getter=lambda: "token",
        is_invisible=False,
        click_checkbox_first=False,
        complete_on_url_change=True,
        start_time=0.0,
    )

    assert result == "result"
    assert solve_calls == [1, 1]


def test_url_change_after_verify_returns_success(monkeypatch: Any) -> None:
    """Navigation after Verify completes the external-browser flow immediately."""
    solver = RecaptchaSolver.__new__(RecaptchaSolver)
    solver.config = type(
        "Config",
        (),
        {"default_timeout": 1.0, "max_attempts": 1},
    )()
    solver.logger = type(
        "Logger",
        (),
        {"debug": lambda *args: None, "info": lambda *args: None},
    )()
    solver._detector = type(
        "Detector",
        (),
        {"ensure_warmup_complete": lambda self: None},
    )()
    captured: dict[str, Any] = {}

    monkeypatch.setattr(solver_module, "human_delay", lambda **kwargs: None)
    monkeypatch.setattr(solver_module, "get_challenge_iframe", lambda *args, **kwargs: object())
    monkeypatch.setattr(solver_module, "is_solved", lambda *args, **kwargs: False)
    monkeypatch.setattr(solver_module, "click_verify_button", lambda browser: True)
    monkeypatch.setattr(
        solver_module,
        "wait_for_verify_result",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("verify-result polling must be skipped after navigation")
        ),
    )
    monkeypatch.setattr(solver, "_determine_captcha_type", lambda browser: object())
    monkeypatch.setattr(solver, "_get_target_class", lambda browser: 1)
    monkeypatch.setattr(
        solver,
        "_get_handler",
        lambda captcha_type: type("Handler", (), {"solve": lambda self, browser, target: [1]})(),
    )
    monkeypatch.setattr(solver, "_get_browser_url", lambda browser: "https://example.com/old")
    monkeypatch.setattr(solver, "_wait_for_url_change", lambda *args, **kwargs: True)

    def build_result(*args: Any, **kwargs: Any) -> str:
        captured.update(kwargs)
        return "url-changed"

    monkeypatch.setattr(solver, "_build_result", build_result)

    result = solver._solve_browser_session(
        object(),
        token_getter=lambda: (_ for _ in ()).throw(
            AssertionError("token wait must be skipped after navigation")
        ),
        is_invisible=False,
        click_checkbox_first=False,
        complete_on_url_change=True,
        start_time=0.0,
    )

    assert result == "url-changed"
    assert captured["token"] == ""


def test_solved_checkbox_completes_without_dom_token(monkeypatch: Any) -> None:
    """A solved checkbox is success even if a site callback consumed the token."""
    solver = RecaptchaSolver.__new__(RecaptchaSolver)
    solver.config = type(
        "Config",
        (),
        {"default_timeout": 1.0, "max_attempts": 1},
    )()
    solver.logger = type(
        "Logger",
        (),
        {
            "debug": lambda *args: None,
            "info": lambda *args: None,
            "warning": lambda *args: None,
        },
    )()
    solver._detector = type(
        "Detector",
        (),
        {"ensure_warmup_complete": lambda self: None},
    )()
    captured: dict[str, Any] = {}
    solved_checks = iter((False, True))

    monkeypatch.setattr(solver_module, "human_delay", lambda **kwargs: None)
    monkeypatch.setattr(solver_module, "get_challenge_iframe", lambda *args, **kwargs: object())
    monkeypatch.setattr(solver_module, "is_solved", lambda *args, **kwargs: next(solved_checks))
    monkeypatch.setattr(solver_module, "click_verify_button", lambda browser: True)
    monkeypatch.setattr(solver, "_determine_captcha_type", lambda browser: object())
    monkeypatch.setattr(solver, "_get_target_class", lambda browser: 1)
    monkeypatch.setattr(
        solver,
        "_get_handler",
        lambda captcha_type: type("Handler", (), {"solve": lambda self, browser, target: [1]})(),
    )
    monkeypatch.setattr(solver, "_get_browser_url", lambda browser: "https://example.com/old")
    monkeypatch.setattr(solver, "_wait_for_url_change", lambda *args, **kwargs: False)
    monkeypatch.setattr(solver, "_read_browser_token", lambda browser: None)

    def build_result(*args: Any, **kwargs: Any) -> str:
        captured.update(kwargs)
        return "solved-without-token"

    monkeypatch.setattr(solver, "_build_result", build_result)

    result = solver._solve_browser_session(
        object(),
        token_getter=lambda: (_ for _ in ()).throw(
            AssertionError("blocking token wait must not be used")
        ),
        is_invisible=False,
        click_checkbox_first=False,
        complete_on_url_change=True,
        start_time=0.0,
    )

    assert result == "solved-without-token"
    assert captured["token"] == ""
