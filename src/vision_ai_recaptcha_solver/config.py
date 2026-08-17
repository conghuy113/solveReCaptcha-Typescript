"""Configuration dataclasses."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from vision_ai_recaptcha_solver.constants import (
    DEFAULT_DOWNLOAD_DIR as _DEFAULT_DOWNLOAD_DIR,
)
from vision_ai_recaptcha_solver.constants import (
    DEFAULT_SERVER_PORT as _DEFAULT_SERVER_PORT,
)
from vision_ai_recaptcha_solver.constants import (
    VALID_LOG_LEVELS,
)

_UNSET = object()

# Regex pattern for validating proxy URLs
# Matches: protocol://[user:pass@]host:port
_PROXY_URL_PATTERN = re.compile(
    r"^(?P<protocol>https?|socks[45]?)://"  # protocol
    r"(?:(?P<user>[^:@]+):(?P<pass>[^@]+)@)?"  # optional user:pass@
    r"(?P<host>[^:/@]+)"  # host
    r":(?P<port>\d+)$",  # :port
    re.IGNORECASE,
)


@dataclass
class SolverConfig:
    """Configuration for the RecaptchaSolver.

    Attributes:
        model_path: Path to the classification model file (str or Path). If None, uses bundled model (auto-downloaded).
        detection_model_path: Path to the detection ONNX model. If None, uses "yolo12x.onnx".
        download_dir: Directory for temporary file downloads.
        server_port: Port for the local HTTPS server (1-65535).
        proxy: Proxy URL in format "protocol://[user:pass@]host:port".
            Supported protocols: http, https, socks4, socks5.
        browser_path: Path to Chrome executable. If None, auto-detected.
        headless: Whether to run browser in headless mode.
        timeout: Maximum time in seconds to wait for token (must be > 0).
        max_attempts: Maximum number of solve attempts before giving up (must be >= 1).
        human_delay_mean: Mean delay in seconds for human like behavior.
        human_delay_sigma: Standard deviation for human like delay.
        log_level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL).
        persist_html: Whether to persist generated HTML files.
        verbose: Whether to enable verbose output from YOLO model.
        conf_threshold: Confidence threshold for tile classification (0.0-1.0).
        min_confidence_threshold: Minimum confidence for top cells to proceed (0.0-1.0).
            If any of the top 3 cells has confidence below this, skip/reload.
        fourth_cell_threshold: Confidence threshold to include 4th cell (0.0-1.0).
        detection_conf_threshold: Confidence threshold for 4x4 detection model (0.0-1.0).
        default_timeout: Default timeout for browser operations in seconds.
        image_download_retries: Number of retries for image downloads.
        image_download_retry_delay: Base delay between retries in seconds.
        register_signal_handlers: Whether to register signal handlers for cleanup on
            SIGINT/SIGTERM. Set to False if your application needs to manage its own
            signal handlers. Default is True.
        cleanup_tmp_on_close: Whether to delete the temporary download directory when
            close() is called. Default is True.
    """

    model_path: Path | str | None = None
    detection_model_path: Path | str | None = None
    download_dir: Path = cast(Path, _UNSET)
    server_port: int = cast(int, _UNSET)
    proxy: str | None = None
    browser_path: str | None = None
    headless: bool = False
    timeout: float = 300.0
    max_attempts: int = 12
    human_delay_mean: float = 0.2
    human_delay_sigma: float = 0.1
    log_level: str = "WARNING"
    persist_html: bool = False
    verbose: bool = False

    # Configurable confidence thresholds
    conf_threshold: float = 0.7
    min_confidence_threshold: float = 0.2
    fourth_cell_threshold: float = 0.7
    detection_conf_threshold: float = 0.6

    default_timeout: float = 10.0

    # Retry configuration for image downloads
    image_download_retries: int = 3
    image_download_retry_delay: float = 1.0

    # Signal handler registration
    register_signal_handlers: bool = True

    # Cleanup
    cleanup_tmp_on_close: bool = True

    _server_port_explicit: bool = field(init=False, repr=False, default=False)
    _download_dir_explicit: bool = field(init=False, repr=False, default=False)

    def __post_init__(self) -> None:
        """Validate configuration values after initialization."""
        server_port_explicit = self.server_port is not _UNSET
        download_dir_explicit = self.download_dir is not _UNSET
        object.__setattr__(self, "_server_port_explicit", server_port_explicit)
        object.__setattr__(self, "_download_dir_explicit", download_dir_explicit)

        if not server_port_explicit:
            object.__setattr__(self, "server_port", _DEFAULT_SERVER_PORT)
        if not download_dir_explicit:
            object.__setattr__(self, "download_dir", _DEFAULT_DOWNLOAD_DIR)

        if not 1 <= self.server_port <= 65535:
            raise ValueError(f"server_port must be between 1 and 65535, got {self.server_port}")

        if self.timeout <= 0:
            raise ValueError(f"timeout must be positive, got {self.timeout}")

        if self.max_attempts < 1:
            raise ValueError(f"max_attempts must be at least 1, got {self.max_attempts}")

        log_level_upper = self.log_level.upper()
        if log_level_upper not in VALID_LOG_LEVELS:
            raise ValueError(f"log_level must be one of {VALID_LOG_LEVELS}, got '{self.log_level}'")
        # Normalize to uppercase
        object.__setattr__(self, "log_level", log_level_upper)

        for threshold_name in [
            "conf_threshold",
            "min_confidence_threshold",
            "fourth_cell_threshold",
            "detection_conf_threshold",
        ]:
            value = getattr(self, threshold_name)
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"{threshold_name} must be between 0.0 and 1.0, got {value}")

        if self.default_timeout <= 0:
            raise ValueError(f"default_timeout must be positive, got {self.default_timeout}")

        if self.human_delay_mean < 0:
            raise ValueError(f"human_delay_mean must be non-negative, got {self.human_delay_mean}")
        if self.human_delay_sigma < 0:
            raise ValueError(
                f"human_delay_sigma must be non-negative, got {self.human_delay_sigma}"
            )

        if self.image_download_retries < 0:
            raise ValueError(
                f"image_download_retries must be non-negative, got {self.image_download_retries}"
            )
        if self.image_download_retry_delay < 0:
            raise ValueError(
                f"image_download_retry_delay must be non-negative, got {self.image_download_retry_delay}"
            )

        # Validate proxy URL format if provided
        if self.proxy is not None:
            self._validate_proxy_url(self.proxy)

        # Validate browser_path exists if provided
        if self.browser_path is not None:
            browser_path = Path(self.browser_path)
            if not browser_path.exists():
                raise ValueError(f"browser_path does not exist: {self.browser_path}")
            if not browser_path.is_file():
                raise ValueError(f"browser_path is not a file: {self.browser_path}")

    @staticmethod
    def _validate_proxy_url(proxy: str) -> None:
        """Validate proxy URL format.

        Args:
            proxy: Proxy URL to validate.

        Raises:
            ValueError: If the proxy URL format is invalid.
        """
        match = _PROXY_URL_PATTERN.match(proxy)
        if not match:
            raise ValueError(
                f"Invalid proxy URL format: '{proxy}'. "
                "Expected format: protocol://[user:pass@]host:port "
                "(e.g., 'http://proxy.example.com:8080' or "
                "'socks5://user:pass@proxy.example.com:1080')"
            )

        # Validate port range
        port = int(match.group("port"))
        if not 1 <= port <= 65535:
            raise ValueError(f"Invalid proxy port: {port}. Must be between 1 and 65535.")
