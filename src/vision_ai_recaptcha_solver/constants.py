"""Just constants."""

from __future__ import annotations

from pathlib import Path

# Config defaults and validation
VALID_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
DEFAULT_SERVER_PORT = 8443
DEFAULT_DOWNLOAD_DIR = Path("tmp")

# Browser selectors
CHECKBOX_SELECTOR = ".recaptcha-checkbox-border"
VERIFY_BUTTON_SELECTOR = "#recaptcha-verify-button"
RELOAD_BUTTON_SELECTOR = "#recaptcha-reload-button"
SOLVED_CHECKBOX_SELECTOR = 'css:span[aria-checked="true"]'
TARGET_TEXT_SELECTOR = "#rc-imageselect strong"
IMAGE_CONTAINER_SELECTOR = "#rc-imageselect-target img"
TILE_SELECTOR_TEMPLATE = "#rc-imageselect-target td"

# Default timeout for browser operations
DEFAULT_TIMEOUT = 10.0
