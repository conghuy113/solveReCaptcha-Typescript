"""Tests for the npm-facing JSON-lines worker."""

from __future__ import annotations

import io
import json
from types import SimpleNamespace
from typing import Any

import pytest

import main as worker_module


def test_status_and_close_protocol() -> None:
    input_stream = io.StringIO(
        '{"id":"1","command":"status"}\n'
        '{"id":"2","command":"close"}\n'
    )
    output_stream = io.StringIO()

    exit_code = worker_module.run_worker(input_stream, output_stream)

    responses = [json.loads(line) for line in output_stream.getvalue().splitlines()]
    assert exit_code == 0
    assert responses[0]["id"] == "1"
    assert responses[0]["ok"] is True
    assert responses[0]["result"]["state"] == "not_initialized"
    assert responses[0]["result"]["frozen"] is False
    assert responses[1] == {
        "id": "2",
        "ok": True,
        "result": {"closed": True},
    }


def test_invalid_json_returns_protocol_error() -> None:
    worker = worker_module.SolverWorker()

    response, should_stop = worker_module.process_protocol_line(worker, "{broken")

    assert should_stop is False
    assert response["ok"] is False
    assert response["error"]["code"] == "INVALID_JSON"


def test_solve_recaptcha_requires_all_existing_server_fields() -> None:
    worker = worker_module.SolverWorker()

    response, _ = worker_module.process_protocol_line(
        worker,
        '{"id":3,"command":"solveReCaptcha","params":{"target_url":"example.com","port":9222}}',
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "INVALID_ARGUMENT"
    assert "click_checkbox" in response["error"]["message"]


def test_solve_recaptcha_serializes_full_solve_result(monkeypatch: Any) -> None:
    class FakeSolver:
        def solve_browser(self, browser: Any, *, click_checkbox_first: bool) -> Any:
            assert browser == "adapted-browser"
            assert click_checkbox_first is False
            return SimpleNamespace(
                token="token-value",
                captcha_type=SimpleNamespace(value="dynamic_3x3"),
                attempts=2,
                time_taken=4.25,
                cookies=[{"name": "session", "value": "cookie"}],
            )

    driver = SimpleNamespace(current_url="https://example.com/signup")
    worker = worker_module.SolverWorker()
    worker._solver = FakeSolver()
    worker._state = "ready"
    monkeypatch.setattr(worker, "_connect_browser", lambda port: driver)
    monkeypatch.setattr(
        worker,
        "_select_target_tab",
        lambda current_driver, target: "https://example.com/signup",
    )
    monkeypatch.setattr(worker, "_make_browser_adapter", lambda current_driver: "adapted-browser")

    result = worker.solveReCaptcha(
        {
            "target_url": "example.com/signup",
            "port": 9222,
            "click_checkbox": False,
        }
    )

    assert result["status"] == "success"
    assert result["token"] == "token-value"
    assert result["captcha_type"] == "dynamic_3x3"
    assert result["completion_reason"] == "token_found"
    assert result["attempts"] == 2


def test_check_browser_reports_connection_failure(monkeypatch: Any) -> None:
    worker = worker_module.SolverWorker()

    def fail(port: int) -> Any:
        raise worker_module.WorkerError(
            "BROWSER_CONNECTION_FAILED",
            f"Cannot connect to {port}",
        )

    monkeypatch.setattr(worker, "_connect_browser", fail)

    response, _ = worker_module.process_protocol_line(
        worker,
        '{"id":"browser","command":"check_browser","params":{"port":9222}}',
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "BROWSER_CONNECTION_FAILED"


def test_unknown_command_is_rejected() -> None:
    worker = worker_module.SolverWorker()

    response, should_stop = worker_module.process_protocol_line(
        worker,
        '{"id":"x","command":"missing"}',
    )

    assert should_stop is False
    assert response["ok"] is False
    assert response["error"]["code"] == "UNKNOWN_COMMAND"


def test_legacy_trigger_command_is_rejected() -> None:
    worker = worker_module.SolverWorker()

    response, should_stop = worker_module.process_protocol_line(
        worker,
        '{"id":"legacy","command":"trigger","params":{'
        '"target_url":"example.com","port":9222,"click_checkbox":false}}',
    )

    assert should_stop is False
    assert response["ok"] is False
    assert response["error"]["code"] == "UNKNOWN_COMMAND"


def test_frozen_worker_never_downloads_missing_models(
    monkeypatch: Any,
    tmp_path: Any,
) -> None:
    worker = worker_module.SolverWorker()
    monkeypatch.setattr(worker_module, "IS_FROZEN", True)

    with pytest.raises(worker_module.WorkerError) as error:
        worker._ensure_models(
            tmp_path / "recaptcha_classification_57k.onnx",
            tmp_path / "yolo12x.onnx",
        )

    assert error.value.code == "MODEL_NOT_FOUND"
    assert "verified model directory" in error.value.message
