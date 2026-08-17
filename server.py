"""Legacy HTTP wrapper around the direct-CDP solver flow."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request

from src.vision_ai_recaptcha_solver.browser.cdp_adapter import CdpChrome
from src.vision_ai_recaptcha_solver.detector.yolo_detector import YOLODetector
from test import print_result, solve_with_existing_browser

BASE_DIR = Path(__file__).resolve().parent
if configured_model_dir := os.environ.get("MODEL_DIR"):
    model_dir = Path(configured_model_dir).expanduser().resolve()
    CLASSIFICATION_MODEL = model_dir / "recaptcha_classification_57k.onnx"
    DETECTION_MODEL = model_dir / "yolo12x.onnx"
else:
    CLASSIFICATION_MODEL = (
        BASE_DIR
        / "src"
        / "vision_ai_recaptcha_solver"
        / "models"
        / "recaptcha_classification_57k.onnx"
    )
    DETECTION_MODEL = BASE_DIR / "yolo12x.onnx"


def ensure_models() -> None:
    """Download missing development models and configure their local paths."""
    CLASSIFICATION_MODEL.parent.mkdir(parents=True, exist_ok=True)
    DETECTION_MODEL.parent.mkdir(parents=True, exist_ok=True)

    if not CLASSIFICATION_MODEL.is_file():
        YOLODetector._download_model(CLASSIFICATION_MODEL)

    if not DETECTION_MODEL.is_file():
        raise RuntimeError(
            "Detection ONNX model is missing. Run: python packaging/prepare_models.py"
        )

    missing_models = [
        str(path)
        for path in (CLASSIFICATION_MODEL, DETECTION_MODEL)
        if not path.is_file()
    ]
    if missing_models:
        raise RuntimeError(f"Model download failed: {', '.join(missing_models)}")

    os.environ["CLASSIFICATION_MODEL_PATH"] = str(CLASSIFICATION_MODEL)
    os.environ["DETECTION_MODEL_PATH"] = str(DETECTION_MODEL)


def _validation_error(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return "Request body must be a JSON object."

    required_fields = ("target_url", "port", "click_checkbox")
    missing_fields = [field for field in required_fields if field not in payload]
    if missing_fields:
        return f"Missing required field(s): {', '.join(missing_fields)}."

    target_url = payload["target_url"]
    port = payload["port"]
    click_checkbox = payload["click_checkbox"]
    if not isinstance(target_url, str) or not target_url.strip():
        return "'target_url' must be a non-empty string."
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        return "'port' must be an integer between 1 and 65535."
    if not isinstance(click_checkbox, bool):
        return "'click_checkbox' must be a boolean."
    return None


app = Flask(__name__)


@app.route("/trigger", methods=["POST"])
def trigger_crawler() -> Any:
    """Solve a challenge in an already-open Chrome tab without ChromeDriver."""
    payload = request.get_json(silent=True)
    validation_error = _validation_error(payload)
    if validation_error:
        return jsonify({"status": "error", "message": validation_error}), 400

    assert isinstance(payload, dict)
    target_url = str(payload["target_url"]).strip()
    port = int(payload["port"])
    click_checkbox = bool(payload["click_checkbox"])
    chrome: CdpChrome | None = None

    try:
        chrome = CdpChrome(port)
        try:
            browser = chrome.select_tab(target_url)
        except LookupError:
            return jsonify(
                {"status": "error", "message": "Không tìm thấy tab mong muốn."}
            ), 404

        result = solve_with_existing_browser(
            browser,
            click_checkbox_first=click_checkbox,
        )
        print_result(result)
        return jsonify(
            {
                "status": "success",
                "message": "Captcha solved successfully.",
                "click_checkbox": click_checkbox,
            }
        )
    except Exception as error:
        print("Python error:", str(error))
        return jsonify({"status": "error", "message": str(error)}), 500
    finally:
        if chrome is not None:
            chrome.close()


if __name__ == "__main__":
    ensure_models()
    app.run(host="0.0.0.0", port=5000)
