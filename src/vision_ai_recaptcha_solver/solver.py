"""Synchronous RecaptchaSolver implementation."""

from __future__ import annotations

import atexit
import contextlib
import importlib
import shutil
import signal
import sys
import threading
import time
import weakref
from collections.abc import Callable
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from vision_ai_recaptcha_solver.browser.navigation import (
    click_checkbox,
    click_reload_button,
    click_verify_button,
    get_challenge_iframe,
    get_challenge_title,
    get_target_keyword,
    is_solved,
    wait_for_verify_result,
)
from vision_ai_recaptcha_solver.captcha.dynamic_handler import DynamicCaptchaHandler
from vision_ai_recaptcha_solver.captcha.selection_handler import SelectionCaptchaHandler
from vision_ai_recaptcha_solver.captcha.square_handler import SquareCaptchaHandler
from vision_ai_recaptcha_solver.config import SolverConfig
from vision_ai_recaptcha_solver.detector.yolo_detector import YOLODetector
from vision_ai_recaptcha_solver.exceptions import (
    CaptchaNotFoundError,
    ElementNotFoundError,
    LowConfidenceError,
    RecaptchaSolverError,
    SolverTimeoutError,
    TokenExtractionError,
    UnsupportedCaptchaError,
)
from vision_ai_recaptcha_solver.logging_config import setup_logging
from vision_ai_recaptcha_solver.resource_allocation import (
    release_solver_resources,
    reserve_solver_resources,
)
from vision_ai_recaptcha_solver.types import CaptchaType, SolveResult
from vision_ai_recaptcha_solver.utils import human_delay

if TYPE_CHECKING:
    from vision_ai_recaptcha_solver.captcha.base_handler import BaseCaptchaHandler


# Global registry for active solver instances
_active_solvers: weakref.WeakSet[RecaptchaSolver] = weakref.WeakSet()
_original_sigint_handler: Any = None
_original_sigterm_handler: Any = None
_atexit_registered: bool = False
_signal_handlers_registered: bool = False
_cleanup_registration_lock = threading.Lock()
_DOWNLOAD_DIR_MARKER = ".vision_ai_recaptcha_solver_owned"


def _cleanup_all_solvers() -> None:
    """Cleanup all active solver instances."""
    for solver in list(_active_solvers):
        with contextlib.suppress(Exception):
            solver.close()


def _signal_handler(signum: int, frame: Any) -> None:
    """Handle interrupt signals by cleaning up browsers before exit."""
    _cleanup_all_solvers()
    # Re-raise the signal with original handler or exit
    if signum == signal.SIGINT and _original_sigint_handler:
        if callable(_original_sigint_handler):
            _original_sigint_handler(signum, frame)
        else:
            sys.exit(130)
    elif signum == signal.SIGTERM and _original_sigterm_handler:
        if callable(_original_sigterm_handler):
            _original_sigterm_handler(signum, frame)
        else:
            sys.exit(143)
    else:
        sys.exit(128 + signum)


def _register_cleanup_handlers(register_signal_handlers: bool = True) -> None:
    """Register signal handlers and atexit for cleanup.

    Args:
        register_signal_handlers: Whether to register signal handlers for SIGINT/SIGTERM.
            Set to False if your application needs to manage its own signal handlers.
            atexit handler is always registered regardless of this setting.
    """
    global _atexit_registered, _signal_handlers_registered
    global _original_sigint_handler, _original_sigterm_handler

    with _cleanup_registration_lock:
        if not _atexit_registered:
            atexit.register(_cleanup_all_solvers)
            _atexit_registered = True

        if not register_signal_handlers or _signal_handlers_registered:
            return

        # Python only permits signal registration from the main thread of the
        # main interpreter. A solver created by an executor or web worker must
        # still be usable; a later solver created in the main thread can perform
        # the signal registration.
        if threading.current_thread() is not threading.main_thread():
            return

        try:
            _original_sigint_handler = signal.getsignal(signal.SIGINT)
            signal.signal(signal.SIGINT, _signal_handler)

            # SIGTERM may not exist on Windows.
            if hasattr(signal, "SIGTERM"):
                _original_sigterm_handler = signal.getsignal(signal.SIGTERM)
                signal.signal(signal.SIGTERM, _signal_handler)
        except ValueError:
            # This can also occur when Python is embedded in a non-main
            # interpreter. Cleanup remains covered by the atexit handler.
            return

        _signal_handlers_registered = True


class RecaptchaSolver:
    """Synchronous reCAPTCHA solver using YOLO object detection.

    This class provides a high-level interface for solving reCAPTCHA challenges
    by combining the recaptcha_domain_replicator library for browser handling with
    YOLO based image detection for solving the visual challenges.

    Example:
        ```python
        from vision_ai_recaptcha_solver import RecaptchaSolver, SolverConfig

        config = SolverConfig(headless=False, timeout=120)

        with RecaptchaSolver(config) as solver:
            result = solver.solve(
                website_key="6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
                website_url="https://www.google.com/recaptcha/api2/demo"
            )
            print(f"Token: {result.token}")
        ```
    """

    def __init__(self, config: SolverConfig | None = None) -> None:
        """Initialize the RecaptchaSolver.

        Args:
            config: Solver configuration. If None, uses default configuration.
        """
        self.config = config or SolverConfig()
        self.logger = setup_logging(self.config.log_level, "vision_ai_recaptcha_solver")
        reserve_solver_resources(self, self.config, self.logger)
        self._owns_download_dir: bool = False
        self._init_download_dir()

        # Initialize detector with both classification and detection models
        self._detector = YOLODetector(
            model_path=self.config.model_path,
            detection_model_path=self.config.detection_model_path,
            verbose=self.config.verbose,
            logger=self.logger,
            conf_threshold=self.config.conf_threshold,
            fourth_cell_threshold=self.config.fourth_cell_threshold,
            detection_conf_threshold=self.config.detection_conf_threshold,
        )

        # Initialize handlers
        self._handlers: dict[CaptchaType, BaseCaptchaHandler] = {
            CaptchaType.DYNAMIC_3X3: DynamicCaptchaHandler(
                self._detector, self.config, self.logger
            ),
            CaptchaType.SELECTION_3X3: SelectionCaptchaHandler(
                self._detector, self.config, self.logger
            ),
            CaptchaType.SQUARE_4X4: SquareCaptchaHandler(self._detector, self.config, self.logger),
        }

        self._replicator: Any | None = None
        self._closed: bool = False

        _active_solvers.add(self)
        _register_cleanup_handlers(register_signal_handlers=self.config.register_signal_handlers)

    def _init_download_dir(self) -> None:
        """Ensure download_dir exists and mark ownership if created by solver."""
        download_dir = self.config.download_dir
        marker_path = download_dir / _DOWNLOAD_DIR_MARKER

        if download_dir.exists():
            if self.config._download_dir_explicit:
                self._owns_download_dir = False
            else:
                self._owns_download_dir = marker_path.exists()
            return

        try:
            download_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            self.logger.debug("Failed to create download directory '%s': %s", download_dir, e)
            return

        if not self.config._download_dir_explicit and self.config.cleanup_tmp_on_close:
            try:
                marker_path.write_text("owned\n", encoding="utf-8")
                self._owns_download_dir = True
            except OSError as e:
                self.logger.debug("Failed to create download dir marker '%s': %s", marker_path, e)

    def __enter__(self) -> RecaptchaSolver:
        """Enter context manager."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> None:
        """Exit context manager and cleanup resources."""
        self.close()

    def close(self) -> None:
        """Close the solver and cleanup all resources."""
        if self._closed:
            return
        self._closed = True

        # Remove from active solvers registry
        _active_solvers.discard(self)

        # Cleanup replicator resources
        self._cleanup_replicator()

        # Cleanup temporary directory
        if self.config.cleanup_tmp_on_close:
            self._cleanup_tmp_directory()

        release_solver_resources(self)

    def _cleanup_replicator(self) -> None:
        """Cleanup the current replicator instance."""
        if self._replicator:
            try:
                self._replicator.close_browser()
            except Exception as e:
                self.logger.debug(f"Error closing browser: {e}")
            try:
                self._replicator.stop_http_server()
            except Exception as e:
                self.logger.debug(f"Error stopping server: {e}")
            finally:
                self._replicator = None

    def _cleanup_tmp_directory(self) -> None:
        """Cleanup the temporary download directory."""
        if not self._owns_download_dir:
            self.logger.debug(
                "Skipping download directory cleanup: %s",
                self.config.download_dir,
            )
            return
        try:
            if self.config.download_dir.exists():
                shutil.rmtree(self.config.download_dir)
                self.logger.debug(f"Cleaned up temporary directory: {self.config.download_dir}")
        except Exception as e:
            self.logger.debug(f"Error cleaning up temporary directory: {e}")

    def solve(
        self,
        website_key: str,
        website_url: str,
        *,
        is_invisible: bool = False,
        action: str | None = None,
        is_enterprise: bool = False,
        api_domain: str = "google.com",
        bypass_domain_check: bool = True,
        use_ssl: bool = True,
        cookies: list[dict[str, Any]] | None = None,
        user_agent: str | None = None,
    ) -> SolveResult:
        """Solve a reCAPTCHA challenge.

        Args:
            website_key: The reCAPTCHA site key.
            website_url: The URL of the page containing the captcha.
            is_invisible: Whether the captcha is invisible reCAPTCHA.
            action: Action name for invisible reCAPTCHA v3.
            is_enterprise: Whether this is an enterprise reCAPTCHA.
            api_domain: API domain (google.com or recaptcha.net).
            bypass_domain_check: Whether to bypass domain verification.
            use_ssl: Whether to use HTTPS for the local server.
            cookies: Optional cookies to set in the browser.
            user_agent: Optional custom user agent string.

        Returns:
            SolveResult with token, cookies, and timing information.

        Raises:
            RecaptchaSolverError: If solving fails.
            TokenExtractionError: If token cannot be extracted.
            ValueError: If website_key or website_url are invalid.
        """
        if not website_key or not website_key.strip():
            raise ValueError("website_key cannot be empty")
        if not website_url or not website_url.strip():
            raise ValueError("website_url cannot be empty")

        parsed = urlparse(website_url)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError(f"Invalid URL format: {website_url}")

        if self._closed:
            raise RecaptchaSolverError("Solver has been closed")

        start_time = time.time()

        try:
            self._cleanup_replicator()

            # The npm native worker only supports solve_browser(). Keep the
            # replicator as a dynamic import so PyInstaller does not bundle a
            # second browser-launching stack that the worker can never use.
            replicator_module = importlib.import_module("recaptcha_domain_replicator")
            replicator_type = replicator_module.RecaptchaDomainReplicator
            self._replicator = replicator_type(
                download_dir=str(self.config.download_dir),
                server_port=self.config.server_port,
                persist_html=self.config.persist_html,
                proxy=self.config.proxy,
                browser_path=self.config.browser_path,
            )

            # Replicate captcha
            cookies_payload: Any = cookies
            browser, token_handle = self._replicator.replicate_captcha(
                website_key=website_key,
                website_url=website_url,
                is_invisible=is_invisible,
                action=action,
                is_enterprise=is_enterprise,
                api_domain=api_domain,
                bypass_domain_check=bypass_domain_check,
                use_ssl=use_ssl,
                cookies=cookies_payload,
                user_agent=user_agent,
                headless=self.config.headless,
            )

            def token_getter() -> str | None:
                return token_handle.wait(timeout=self.config.timeout) if token_handle else None

            return self._solve_browser_session(
                browser,
                token_getter=token_getter,
                is_invisible=is_invisible,
                click_checkbox_first=not is_invisible,
                complete_on_url_change=False,
                start_time=start_time,
            )

        except RecaptchaSolverError:
            raise
        except (RuntimeError, OSError, ValueError) as e:
            raise RecaptchaSolverError(f"Solve failed: {e}") from e

    def solve_browser(
        self,
        browser: Any,
        *,
        click_checkbox_first: bool = False,
    ) -> SolveResult:
        """Solve a reCAPTCHA challenge in an existing browser session.

        The browser must expose the DrissionPage-compatible methods used by the
        navigation helpers. This method does not create, own, or close the browser.
        The final token is read from the page's ``g-recaptcha-response`` element.

        Args:
            browser: Existing DrissionPage browser or tab positioned on the page
                containing the reCAPTCHA widget.
            click_checkbox_first: Whether to click the reCAPTCHA checkbox before
                solving. Leave False when the image challenge is already open.

        Returns:
            SolveResult with token, cookies, timing, captcha type, and attempts.
        """
        if browser is None:
            raise ValueError("browser cannot be None")
        if self._closed:
            raise RecaptchaSolverError("Solver has been closed")

        start_time = time.time()

        try:
            return self._solve_browser_session(
                browser,
                token_getter=lambda: self._wait_for_browser_token(browser),
                is_invisible=False,
                click_checkbox_first=click_checkbox_first,
                complete_on_url_change=True,
                start_time=start_time,
            )
        except RecaptchaSolverError:
            raise
        except (RuntimeError, OSError, ValueError) as e:
            raise RecaptchaSolverError(f"Solve failed: {e}") from e

    def _solve_browser_session(
        self,
        browser: Any,
        *,
        token_getter: Callable[[], str | None],
        is_invisible: bool,
        click_checkbox_first: bool,
        complete_on_url_change: bool,
        start_time: float,
    ) -> SolveResult:
        """Run the common solving flow against a ready browser session."""
        if not browser:
            raise CaptchaNotFoundError("Failed to initialize browser session")

        attempts = 0
        last_captcha_type = CaptchaType.UNKNOWN

        if is_invisible:
            self.logger.info("Invisible reCAPTCHA (v3) detected - waiting for token...")
            token = token_getter()
            if not token:
                raise TokenExtractionError("Failed to extract reCAPTCHA v3 token")

            self.logger.info("reCAPTCHA token obtained successfully!")
            return self._build_result(
                browser,
                token,
                start_time,
                CaptchaType.INVISIBLE,
                attempts=0,
            )

        if click_checkbox_first:
            human_delay(mean=0.8, sigma=0.2)

            try:
                click_checkbox(browser)
            except ElementNotFoundError as e:
                raise CaptchaNotFoundError(f"Could not find captcha checkbox: {e}") from e

            human_delay(mean=0.5, sigma=0.3)
        else:
            # An externally supplied browser may already have opened the image
            # challenge. Do not click the checkbox again because it may be hidden
            # or no longer present in the active UI state.
            challenge_frame = get_challenge_iframe(
                browser,
                timeout=self.config.default_timeout,
            )
            if not challenge_frame and not is_solved(browser, timeout=2):
                raise CaptchaNotFoundError(
                    "Existing browser has no active reCAPTCHA challenge iframe"
                )

        if is_solved(browser, timeout=2):
            self.logger.info("Captcha solved immediately on checkbox click (no challenge)")
            token = self._read_browser_token(browser) if complete_on_url_change else token_getter()
            if not token and not complete_on_url_change:
                raise TokenExtractionError(
                    "Failed to extract reCAPTCHA token after immediate solve"
                )
            return self._build_result(
                browser,
                token or "",
                start_time,
                CaptchaType.NO_CHALLENGE,
                attempts=0,
            )

        self._detector.ensure_warmup_complete()

        while attempts < self.config.max_attempts:
            attempts += 1
            self.logger.debug(f"Solve attempt {attempts}/{self.config.max_attempts}")

            try:
                captcha_type = self._determine_captcha_type(browser)
                last_captcha_type = captcha_type
                target_class = self._get_target_class(browser)

                if target_class is None:
                    self.logger.info("Unknown target, reloading captcha")
                    self._reload_challenge(browser)
                    continue

                handler = self._get_handler(captcha_type)
                clicked_cells = handler.solve(browser, target_class)

                if not clicked_cells:
                    self.logger.info("No cells clicked, reloading")
                    self._reload_challenge(browser)
                    continue

                human_delay(mean=0.3, sigma=0.2)
                url_before_verify = self._get_browser_url(browser)
                verify_clicked = click_verify_button(browser)

                if not verify_clicked:
                    self.logger.warning("Verify/Next button was not clicked; retrying challenge")
                    human_delay(mean=0.5, sigma=0.1)
                    continue

                if complete_on_url_change and url_before_verify:
                    if self._wait_for_url_change(
                        browser,
                        url_before_verify,
                        timeout=5.0,
                    ):
                        self.logger.info("Page URL changed after verification; flow completed")
                        return self._build_result(
                            browser,
                            token="",
                            start_time=start_time,
                            captcha_type=last_captcha_type,
                            attempts=attempts,
                        )

                    token = self._read_browser_token(browser)
                    if token:
                        self.logger.info("reCAPTCHA token found after verification")
                        return self._build_result(
                            browser,
                            token=token,
                            start_time=start_time,
                            captcha_type=last_captcha_type,
                            attempts=attempts,
                        )

                    if is_solved(browser, timeout=2):
                        self.logger.info("Captcha is solved without a URL change; flow completed")
                        return self._build_result(
                            browser,
                            token="",
                            start_time=start_time,
                            captcha_type=last_captcha_type,
                            attempts=attempts,
                        )

                    self.logger.info("Page URL is unchanged after verification; continuing solve")
                    continue

                if wait_for_verify_result(browser, timeout=self.config.default_timeout):
                    self.logger.info("Captcha solved successfully!")
                    break

                human_delay(mean=0.2, sigma=0.1)

            except LowConfidenceError as e:
                self.logger.info(f"Low confidence detection, reloading: {e}")
                self._reload_challenge(browser)

            except (ElementNotFoundError, UnsupportedCaptchaError) as e:
                self.logger.warning(f"Attempt {attempts} failed: {e}")
                human_delay(mean=0.5, sigma=0.1)

        if complete_on_url_change:
            token = self._read_browser_token(browser)
            if token or is_solved(browser, timeout=2):
                return self._build_result(
                    browser,
                    token=token or "",
                    start_time=start_time,
                    captcha_type=last_captcha_type,
                    attempts=attempts,
                )

            raise SolverTimeoutError(
                f"Captcha was not completed after {attempts} verification attempts"
            )

        token = token_getter()
        if not token:
            raise TokenExtractionError("Failed to extract reCAPTCHA token")

        return self._build_result(
            browser,
            token,
            start_time,
            last_captcha_type,
            attempts,
        )

    def _get_browser_url(self, browser: Any) -> str | None:
        """Read the current URL from a DrissionPage or adapted browser object."""
        tab = browser.latest_tab if hasattr(browser, "latest_tab") else browser

        for attribute_name in ("url", "current_url"):
            try:
                value = getattr(tab, attribute_name, None)
                if callable(value):
                    value = value()
                if value:
                    return str(value)
            except Exception:
                continue

        return None

    def _wait_for_url_change(
        self,
        browser: Any,
        previous_url: str,
        *,
        timeout: float,
    ) -> bool:
        """Poll for navigation after Verify until timeout expires."""
        deadline = time.time() + timeout

        while time.time() < deadline:
            current_url = self._get_browser_url(browser)
            if current_url and current_url != previous_url:
                return True
            time.sleep(0.2)

        current_url = self._get_browser_url(browser)
        return bool(current_url and current_url != previous_url)

    def _reload_challenge(self, browser: Any) -> None:
        """Reload the current challenge and wait until its tile grid is available."""
        click_reload_button(browser)
        human_delay(
            mean=self.config.human_delay_mean,
            sigma=self.config.human_delay_sigma,
        )
        challenge_frame = get_challenge_iframe(browser, timeout=self.config.default_timeout)
        if challenge_frame:
            challenge_frame.ele(
                "#rc-imageselect-target td",
                timeout=self.config.default_timeout,
            )

    def _wait_for_browser_token(self, browser: Any) -> str | None:
        """Wait for a reCAPTCHA token exposed in the existing page DOM."""
        deadline = time.time() + self.config.timeout

        while time.time() < deadline:
            token = self._read_browser_token(browser)
            if token:
                return token
            time.sleep(0.2)

        return None

    def _read_browser_token(self, browser: Any) -> str | None:
        """Read the current DOM token once without blocking."""
        tab = browser.latest_tab if hasattr(browser, "latest_tab") else browser
        if not hasattr(tab, "run_js"):
            return None

        script = """
            const elements = document.querySelectorAll(
                'textarea[name="g-recaptcha-response"], #g-recaptcha-response'
            );
            for (const element of elements) {
                if (element && element.value) {
                    return element.value;
                }
            }
            if (typeof grecaptcha !== 'undefined' && grecaptcha.getResponse) {
                try {
                    const response = grecaptcha.getResponse();
                    if (response) {
                        return response;
                    }
                } catch (error) {
                    // Some pages require an explicit widget id; the textarea
                    // lookup above remains the primary extraction path.
                }
            }
            return '';
        """

        try:
            token = tab.run_js(script)
            return str(token) if token else None
        except Exception:
            return None

    def _build_result(
        self,
        browser: Any,
        token: str,
        start_time: float,
        captcha_type: CaptchaType,
        attempts: int,
    ) -> SolveResult:
        """Build a solve result for either an owned or external browser."""
        return SolveResult(
            token=token,
            cookies=self._get_cookies(browser),
            time_taken=round(time.time() - start_time, 2),
            captcha_type=captcha_type,
            attempts=attempts,
        )

    def _determine_captcha_type(self, browser: Any) -> CaptchaType:
        """Determine the type of captcha challenge.

        Args:
            browser: Browser instance.

        Returns:
            CaptchaType enum value.
        """
        title = get_challenge_title(browser)
        title_lower = title.lower()

        if "squares" in title_lower:
            return CaptchaType.SQUARE_4X4
        elif "none" in title_lower:
            # "Click skip if there are none" indicates dynamic
            return CaptchaType.DYNAMIC_3X3
        else:
            return CaptchaType.SELECTION_3X3

    def _get_target_class(self, browser: Any) -> int | None:
        """Get the YOLO class index for the target object.

        Args:
            browser: Browser instance.

        Returns:
            YOLO class index, or None if target is unknown.
        """
        keyword = get_target_keyword(browser)
        if not keyword:
            return None

        return self._detector.get_target_class(keyword)

    def _get_handler(self, captcha_type: CaptchaType) -> BaseCaptchaHandler:
        """Get the appropriate handler for a captcha type.

        Args:
            captcha_type: Type of captcha.

        Returns:
            Handler instance.

        Raises:
            UnsupportedCaptchaError: If captcha type is not supported.
        """
        handler = self._handlers.get(captcha_type)
        if not handler:
            raise UnsupportedCaptchaError(f"Unsupported captcha type: {captcha_type}")
        return handler

    def _get_cookies(self, browser: Any) -> list[dict[str, Any]]:
        """Get cookies from the browser.

        Args:
            browser: DrissionPage browser instance.

        Returns:
            List of cookie dictionaries.
        """
        try:
            if hasattr(browser, "cookies"):
                cookies = browser.cookies(all_info=True)
                return list(cookies) if cookies else []

            # Try latest_tab
            if hasattr(browser, "latest_tab"):
                tab = browser.latest_tab
                if hasattr(tab, "cookies"):
                    cookies = tab.cookies(all_info=True)
                    return list(cookies) if cookies else []

            return []
        except (AttributeError, RuntimeError) as e:
            self.logger.debug(f"Error getting cookies: {e}")
            return []
