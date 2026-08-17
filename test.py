"""Use the solver with an already-open Chrome session through direct CDP."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
SRC_PATH = ROOT / "src"
if SRC_PATH.exists() and str(SRC_PATH) not in sys.path:
    sys.path.insert(0, str(SRC_PATH))

from vision_ai_recaptcha_solver import (  # noqa: E402
    RecaptchaSolver,
    SolverConfig,
    SolveResult,
)
from vision_ai_recaptcha_solver.browser.cdp_adapter import CdpChrome  # noqa: E402


def solve_with_existing_browser(
    browser: Any,
    *,
    click_checkbox_first: bool = False,
) -> SolveResult:
    """Solve the reCAPTCHA displayed in an existing CDP browser tab."""
    config = SolverConfig(
        model_path=os.environ.get("CLASSIFICATION_MODEL_PATH"),
        detection_model_path=os.environ.get("DETECTION_MODEL_PATH"),
        timeout=180,
        log_level="INFO",
        register_signal_handlers=False,
    )

    # RecaptchaSolver does not own `browser`, so exiting this context only
    # releases detector and temporary resources created by the solver.
    with RecaptchaSolver(config) as solver:
        return solver.solve_browser(
            browser,
            click_checkbox_first=click_checkbox_first,
        )


def print_result(result: SolveResult) -> None:
    """Print a compact summary without exposing the complete token."""
    token_preview = f"{result.token[:50]}..." if result.token else "<URL changed>"
    print(f"Token: {token_preview}")
    print(f"Time: {result.time_taken}s")
    print(f"Type: {result.captcha_type.value}")
    print(f"Attempts: {result.attempts}")


def main() -> None:
    """Attach directly to Chrome, select the requested tab, and solve it."""
    port = int(os.environ.get("CHROME_DEBUG_PORT", "9222"))
    target_url = os.environ.get("TARGET_URL", "example.com")
    click_checkbox = os.environ.get("CLICK_CHECKBOX", "false").lower() == "true"

    chrome = CdpChrome(port)
    try:
        browser = chrome.select_tab(target_url)
        print(f"Target tab found: {browser.url}")
        result = solve_with_existing_browser(
            browser,
            click_checkbox_first=click_checkbox,
        )
        print_result(result)
    finally:
        # Only the CDP WebSocket is closed; the user's Chrome stays open.
        chrome.close()


if __name__ == "__main__":
    main()
