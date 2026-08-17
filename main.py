"""Persistent local worker used by the npm wrapper.

The worker deliberately does not expose an HTTP server.  A Node.js child process
sends one JSON object per line on stdin and receives one JSON response per line
on stdout.  All application logs are redirected to stderr so they cannot corrupt
the protocol stream.

Request example::

    {"id":"1","command":"solveReCaptcha","params":{
      "target_url":"https://example.com", "port":9222,
      "click_checkbox":false
    }}

Response example::

    {"id":"1","ok":true,"result":{...}}
"""

from __future__ import annotations

import contextlib
import dataclasses
import json
import os
import platform
import sys
import traceback
from enum import Enum
from pathlib import Path
from typing import Any, TextIO

PROTOCOL_VERSION = 1
IS_FROZEN = bool(getattr(sys, "frozen", False))
# With a PyInstaller onedir build, models are shipped next to the executable so
# every npm platform package remains completely offline at runtime.
BASE_DIR = (
    Path(sys.executable).resolve().parent
    if IS_FROZEN
    else Path(__file__).resolve().parent
)
SRC_DIR = BASE_DIR / "src"
if SRC_DIR.is_dir() and str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))


class WorkerError(Exception):
    """An expected error that can be safely returned to the npm client."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def _require_object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WorkerError("INVALID_ARGUMENT", f"'{name}' must be an object.")
    return value


def _require_non_empty_string(params: dict[str, Any], name: str) -> str:
    if name not in params:
        raise WorkerError("INVALID_ARGUMENT", f"Missing required field: {name}.")
    value = params[name]
    if not isinstance(value, str) or not value.strip():
        raise WorkerError("INVALID_ARGUMENT", f"'{name}' must be a non-empty string.")
    return value.strip()


def _require_port(params: dict[str, Any]) -> int:
    if "port" not in params:
        raise WorkerError("INVALID_ARGUMENT", "Missing required field: port.")
    value = params["port"]
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise WorkerError("INVALID_ARGUMENT", "'port' must be an integer between 1 and 65535.")
    return value


def _require_boolean(params: dict[str, Any], name: str) -> bool:
    if name not in params:
        raise WorkerError("INVALID_ARGUMENT", f"Missing required field: {name}.")
    value = params[name]
    if not isinstance(value, bool):
        raise WorkerError("INVALID_ARGUMENT", f"'{name}' must be a boolean.")
    return value


def _optional_positive_number(params: dict[str, Any], name: str, default: float) -> float:
    value = params.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise WorkerError("INVALID_ARGUMENT", f"'{name}' must be a positive number.")
    return float(value)


def _optional_positive_integer(params: dict[str, Any], name: str, default: int) -> int:
    value = params.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise WorkerError("INVALID_ARGUMENT", f"'{name}' must be an integer greater than zero.")
    return value


def _json_default(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _default_cache_dir() -> Path:
    configured = os.environ.get("VISION_AI_RECAPTCHA_CACHE_DIR")
    if configured:
        return Path(configured).expanduser().resolve()

    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        root = Path(os.environ["LOCALAPPDATA"])
    elif os.environ.get("XDG_CACHE_HOME"):
        root = Path(os.environ["XDG_CACHE_HOME"])
    else:
        root = Path.home() / ".cache"
    return root / "vision-ai-recaptcha-solver"


class SolverWorker:
    """Own one warm solver and one direct CDP session at a time."""

    def __init__(self) -> None:
        self._state = "not_initialized"
        self._solver: Any | None = None
        self._driver: Any | None = None
        self._driver_address: str | None = None
        self._model_paths: tuple[Path, Path] | None = None
        self._active_request_id: str | int | None = None
        self._last_error: str | None = None

    def status(self) -> dict[str, Any]:
        warmup_complete = False
        if self._solver is not None:
            detector = getattr(self._solver, "_detector", None)
            warmup_complete = bool(getattr(detector, "is_warmup_complete", False))

        return {
            "protocol_version": PROTOCOL_VERSION,
            "frozen": IS_FROZEN,
            "state": self._state,
            "worker_pid": os.getpid(),
            "models_loaded": self._solver is not None,
            "warmup_completed": warmup_complete,
            "browser_connected": self._driver is not None,
            "debugger_address": self._driver_address,
            "active_request_id": self._active_request_id,
            "last_error": self._last_error,
        }

    def initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        """Ensure model files exist, create the solver once, and warm it up."""
        if self._solver is not None:
            return self._initialize_result()

        self._state = "initializing"
        try:
            cache_dir = _default_cache_dir()
            classification_path, detection_path = self._resolve_model_paths(params)
            self._ensure_models(classification_path, detection_path)

            from vision_ai_recaptcha_solver import RecaptchaSolver, SolverConfig

            timeout_ms = _optional_positive_number(params, "timeout_ms", 180_000)
            max_attempts = _optional_positive_integer(params, "max_attempts", 12)
            default_timeout_ms = _optional_positive_number(params, "default_timeout_ms", 10_000)
            log_level = params.get("log_level", "INFO")
            if not isinstance(log_level, str):
                raise WorkerError("INVALID_ARGUMENT", "'log_level' must be a string.")

            configured_download_dir = params.get("download_dir")
            if configured_download_dir is None:
                download_dir = cache_dir / "tmp" / f"worker-{os.getpid()}"
            elif isinstance(configured_download_dir, str) and configured_download_dir.strip():
                download_dir = Path(configured_download_dir).expanduser().resolve()
            else:
                raise WorkerError("INVALID_ARGUMENT", "'download_dir' must be a non-empty string.")

            config = SolverConfig(
                model_path=classification_path,
                detection_model_path=detection_path,
                download_dir=download_dir,
                timeout=timeout_ms / 1000,
                max_attempts=max_attempts,
                default_timeout=default_timeout_ms / 1000,
                log_level=log_level,
                register_signal_handlers=False,
            )
            solver = RecaptchaSolver(config)
            solver._detector.ensure_warmup_complete(timeout=timeout_ms / 1000)

            self._solver = solver
            self._model_paths = (classification_path, detection_path)
            self._state = "ready"
            self._last_error = None
            return self._initialize_result()
        except Exception:
            self._state = "failed"
            raise

    def _initialize_result(self) -> dict[str, Any]:
        classification_path, detection_path = self._model_paths or (Path(""), Path(""))
        return {
            "ready": self._solver is not None,
            "worker_pid": os.getpid(),
            "python_version": platform.python_version(),
            "models": {
                "classification": str(classification_path),
                "detection": str(detection_path),
            },
            "warmup_completed": self.status()["warmup_completed"],
        }

    def _resolve_model_paths(self, params: dict[str, Any]) -> tuple[Path, Path]:
        configured_model_dir = params.get("model_dir") or os.environ.get("MODEL_DIR")
        if configured_model_dir is not None:
            if not isinstance(configured_model_dir, str) or not configured_model_dir.strip():
                raise WorkerError("INVALID_ARGUMENT", "'model_dir' must be a non-empty string.")
            model_dir = Path(configured_model_dir).expanduser().resolve()
            return (
                model_dir / "recaptcha_classification_57k.onnx",
                model_dir / "yolo12x.onnx",
            )

        if IS_FROZEN:
            raise WorkerError(
                "MODEL_NOT_FOUND",
                "MODEL_DIR must point to the verified npm model cache.",
            )

        bundled_models = BASE_DIR / "models"
        bundled_classification = bundled_models / "recaptcha_classification_57k.onnx"
        bundled_detection = bundled_models / "yolo12x.onnx"
        if bundled_classification.is_file() and bundled_detection.is_file():
            return bundled_classification, bundled_detection

        local_classification = (
            BASE_DIR
            / "src"
            / "vision_ai_recaptcha_solver"
            / "models"
            / "recaptcha_classification_57k.onnx"
        )
        local_detection = BASE_DIR / "yolo12x.onnx"
        cache_models = _default_cache_dir() / "models"
        classification_path = (
            local_classification
            if local_classification.is_file()
            else cache_models / "recaptcha_classification_57k.onnx"
        )
        detection_path = (
            local_detection if local_detection.is_file() else cache_models / "yolo12x.onnx"
        )
        return classification_path, detection_path

    def _ensure_models(self, classification_path: Path, detection_path: Path) -> None:
        missing_before_prepare = [
            str(path)
            for path in (classification_path, detection_path)
            if not path.is_file()
        ]
        if IS_FROZEN and missing_before_prepare:
            raise WorkerError(
                "MODEL_NOT_FOUND",
                "The verified model directory is incomplete.",
                details={"missing_models": missing_before_prepare},
            )

        classification_path.parent.mkdir(parents=True, exist_ok=True)
        detection_path.parent.mkdir(parents=True, exist_ok=True)

        if not classification_path.is_file():
            from vision_ai_recaptcha_solver.detector.yolo_detector import YOLODetector

            YOLODetector._download_model(classification_path)

        if not detection_path.is_file():
            raise WorkerError(
                "MODEL_NOT_FOUND",
                "The exported detection ONNX model is missing. Run packaging/prepare_models.py.",
                details={"missing_model": str(detection_path)},
            )

        missing = [
            str(path)
            for path in (classification_path, detection_path)
            if not path.is_file()
        ]
        if missing:
            raise WorkerError(
                "MODEL_NOT_FOUND",
                f"Model preparation failed: {', '.join(missing)}",
            )

        os.environ["CLASSIFICATION_MODEL_PATH"] = str(classification_path)
        os.environ["DETECTION_MODEL_PATH"] = str(detection_path)

    def check_browser(self, params: dict[str, Any]) -> dict[str, Any]:
        port = _require_port(params)
        driver = self._connect_browser(port)
        try:
            tabs = driver.list_tabs()
            return {
                "connected": True,
                "debugger_address": self._driver_address,
                "tab_count": len(tabs),
                "browser_version": driver.browser_version,
            }
        except Exception as error:
            self._disconnect_driver()
            raise WorkerError(
                "BROWSER_CONNECTION_FAILED",
                f"Connected browser became unavailable: {error}",
            ) from error

    def list_tabs(self, params: dict[str, Any]) -> dict[str, Any]:
        port = _require_port(params)
        driver = self._connect_browser(port)
        return {"tabs": self._collect_tabs(driver)}

    def inspect_captcha(self, params: dict[str, Any]) -> dict[str, Any]:
        port = _require_port(params)
        target_url = _require_non_empty_string(params, "target_url")
        driver = self._connect_browser(port)
        selected_url = self._select_target_tab(driver, target_url)
        browser = self._make_browser_adapter(driver)

        from vision_ai_recaptcha_solver.browser.navigation import (
            get_challenge_iframe,
            get_challenge_title,
            get_checkbox_iframe,
            get_target_keyword,
            is_solved,
        )

        solved = is_solved(browser, timeout=1)
        challenge = get_challenge_iframe(browser, timeout=2)
        checkbox = None if challenge else get_checkbox_iframe(browser, timeout=2)
        title = get_challenge_title(browser, timeout=2) if challenge else ""
        title_lower = title.lower()

        if solved:
            state = "solved"
        elif challenge:
            state = "challenge"
        elif checkbox:
            state = "checkbox"
        else:
            state = "not_found"

        captcha_type: str | None = None
        if challenge:
            if "squares" in title_lower:
                captcha_type = "square_4x4"
            elif "none" in title_lower:
                captcha_type = "dynamic_3x3"
            else:
                captcha_type = "selection_3x3"

        return {
            "found": state != "not_found",
            "state": state,
            "captcha_type": captcha_type,
            "target": get_target_keyword(browser, timeout=2) if challenge else None,
            "token_present": bool(self._read_page_token(browser)),
            "current_url": selected_url,
        }

    def solveReCaptcha(  # noqa: N802 - matches the public TypeScript API
        self, params: dict[str, Any]
    ) -> dict[str, Any]:
        """Solve reCAPTCHA in an already-open Chrome browser without HTTP."""
        target_url = _require_non_empty_string(params, "target_url")
        port = _require_port(params)
        click_checkbox = _require_boolean(params, "click_checkbox")

        if self._solver is None:
            self.initialize({})
        assert self._solver is not None

        driver = self._connect_browser(port)
        initial_url = self._select_target_tab(driver, target_url)
        browser = self._make_browser_adapter(driver)

        result = self._solver.solve_browser(
            browser,
            click_checkbox_first=click_checkbox,
        )
        current_url = str(driver.current_url)
        token = result.token or None
        if token:
            completion_reason = "token_found"
        elif current_url != initial_url:
            completion_reason = "url_changed"
        else:
            completion_reason = "checkbox_solved"

        return {
            "status": "success",
            "message": "Captcha solved successfully.",
            "click_checkbox": click_checkbox,
            "token": token,
            "captcha_type": result.captcha_type.value,
            "attempts": result.attempts,
            "time_taken": result.time_taken,
            "cookies": result.cookies,
            "current_url": current_url,
            "completion_reason": completion_reason,
        }

    def _connect_browser(self, port: int) -> Any:
        address = f"127.0.0.1:{port}"
        if self._driver is not None and self._driver_address == address:
            try:
                self._driver.is_available()
                return self._driver
            except Exception:
                self._disconnect_driver()

        if self._driver is not None:
            self._disconnect_driver()

        try:
            from vision_ai_recaptcha_solver.browser.cdp_adapter import CdpChrome

            driver = CdpChrome(port, host="127.0.0.1")
        except Exception as error:
            raise WorkerError(
                "BROWSER_CONNECTION_FAILED",
                f"Could not connect to Chrome at {address}: {error}",
                details={"debugger_address": address},
            ) from error

        self._driver = driver
        self._driver_address = address
        return driver

    def _disconnect_driver(self) -> None:
        driver = self._driver
        self._driver = None
        self._driver_address = None
        if driver is None:
            return

        # Closing the target WebSocket never closes the caller-owned Chrome.
        with contextlib.suppress(Exception):
            driver.close()

    def _collect_tabs(self, driver: Any) -> list[dict[str, Any]]:
        return [
            {
                "id": str(tab["id"]),
                "url": str(tab["url"]),
                "title": str(tab["title"]),
                "active": bool(tab["active"]),
            }
            for tab in driver.list_tabs()
        ]

    def _select_target_tab(self, driver: Any, target_url: str) -> str:
        tabs = self._collect_tabs(driver)
        exact = [tab for tab in tabs if tab["url"] == target_url]
        contains = [tab for tab in tabs if target_url in tab["url"]]
        matches = exact or contains
        if not matches:
            raise WorkerError(
                "TARGET_TAB_NOT_FOUND",
                f"No browser tab URL contains: {target_url}",
                details={"available_urls": [tab["url"] for tab in tabs]},
            )

        try:
            browser = driver.select_tab(target_url)
            return str(browser.url)
        except Exception as error:
            raise WorkerError(
                "TARGET_TAB_UNAVAILABLE",
                f"Target tab became unavailable: {error}",
            ) from error

    @staticmethod
    def _make_browser_adapter(driver: Any) -> Any:
        return driver.current_tab

    @staticmethod
    def _read_page_token(browser: Any) -> str | None:
        script = """
            const elements = document.querySelectorAll(
                'textarea[name="g-recaptcha-response"], #g-recaptcha-response'
            );
            for (const element of elements) {
                if (element && element.value) return element.value;
            }
            if (typeof grecaptcha !== 'undefined' && grecaptcha.getResponse) {
                try {
                    const response = grecaptcha.getResponse();
                    if (response) return response;
                } catch (error) {}
            }
            return '';
        """
        try:
            token = browser.run_js(script)
            return str(token) if token else None
        except Exception:
            return None

    def close(self) -> dict[str, Any]:
        self._state = "closing"
        self._disconnect_driver()
        if self._solver is not None:
            with contextlib.suppress(Exception):
                self._solver.close()
            self._solver = None
        self._state = "closed"
        return {"closed": True}

    def dispatch(
        self,
        command: str,
        params: dict[str, Any],
        request_id: str | int | None,
    ) -> dict[str, Any]:
        handlers = {
            "initialize": self.initialize,
            "check_browser": self.check_browser,
            "list_tabs": self.list_tabs,
            "inspect_captcha": self.inspect_captcha,
            "solveReCaptcha": self.solveReCaptcha,
            "status": lambda unused: self.status(),
            "close": lambda unused: self.close(),
        }
        handler = handlers.get(command)
        if handler is None:
            raise WorkerError("UNKNOWN_COMMAND", f"Unknown command: {command}")

        self._active_request_id = request_id
        if command == "solveReCaptcha":
            self._state = "solving"
        try:
            result = handler(params)
            if command == "solveReCaptcha":
                self._state = "ready"
            self._last_error = None
            return result
        except Exception as error:
            self._last_error = str(error)
            if command == "solveReCaptcha":
                self._state = "ready" if self._solver is not None else "failed"
            raise
        finally:
            self._active_request_id = None


_ERROR_CODES = {
    "BrowserError": "BROWSER_ERROR",
    "CaptchaNotFoundError": "CAPTCHA_NOT_FOUND",
    "DetectionError": "DETECTION_FAILED",
    "ElementNotFoundError": "ELEMENT_NOT_FOUND",
    "ImageDownloadError": "IMAGE_DOWNLOAD_FAILED",
    "LowConfidenceError": "LOW_CONFIDENCE",
    "ModelNotFoundError": "MODEL_NOT_FOUND",
    "NavigationError": "NAVIGATION_FAILED",
    "SolverTimeoutError": "SOLVER_TIMEOUT",
    "TokenExtractionError": "TOKEN_EXTRACTION_FAILED",
    "UnsupportedCaptchaError": "UNSUPPORTED_CAPTCHA",
}


def _serialize_error(error: Exception) -> dict[str, Any]:
    if isinstance(error, WorkerError):
        payload: dict[str, Any] = {
            "code": error.code,
            "message": error.message,
            "type": type(error).__name__,
        }
        if error.details is not None:
            payload["details"] = error.details
        return payload

    error_type = type(error).__name__
    return {
        "code": _ERROR_CODES.get(error_type, "INTERNAL_ERROR"),
        "message": str(error) or error_type,
        "type": error_type,
    }


def process_protocol_line(
    worker: SolverWorker,
    raw_line: str,
) -> tuple[dict[str, Any], bool]:
    """Parse and execute one protocol request."""
    request_id: str | int | None = None
    command: str | None = None
    try:
        request = json.loads(raw_line)
        request = _require_object(request, "request")
        request_id = request.get("id")
        command_value = request.get("command")
        if not isinstance(command_value, str) or not command_value.strip():
            raise WorkerError("INVALID_REQUEST", "'command' must be a non-empty string.")
        command = command_value.strip()
        params = _require_object(request.get("params", {}), "params")
        result = worker.dispatch(command, params, request_id)
        return {"id": request_id, "ok": True, "result": result}, command == "close"
    except json.JSONDecodeError as error:
        response = {
            "id": request_id,
            "ok": False,
            "error": {
                "code": "INVALID_JSON",
                "message": f"Invalid JSON: {error.msg}",
                "type": type(error).__name__,
            },
        }
        return response, False
    except Exception as error:
        if not isinstance(error, WorkerError):
            traceback.print_exc(file=sys.stderr)
        return {
            "id": request_id,
            "ok": False,
            "error": _serialize_error(error),
        }, command == "close"


def run_worker(input_stream: TextIO, protocol_output: TextIO) -> int:
    """Run the blocking JSON-lines loop until EOF or a close command."""
    worker = SolverWorker()
    try:
        for raw_line in input_stream:
            if not raw_line.strip():
                continue
            response, should_stop = process_protocol_line(worker, raw_line)
            protocol_output.write(
                json.dumps(response, ensure_ascii=False, default=_json_default) + "\n"
            )
            protocol_output.flush()
            if should_stop:
                break
    finally:
        worker.close()
    return 0


def main() -> int:
    protocol_output = sys.stdout
    # Third-party libraries occasionally print during import/model loading.
    # Redirecting stdout for the worker lifetime keeps stdout machine-readable.
    with contextlib.redirect_stdout(sys.stderr):
        return run_worker(sys.stdin, protocol_output)


if __name__ == "__main__":
    raise SystemExit(main())
