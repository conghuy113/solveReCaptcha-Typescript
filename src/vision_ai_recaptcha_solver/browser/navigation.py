"""Browser navigation utilities for reCAPTCHA iframe handling."""

from __future__ import annotations

import logging
import time
from typing import Any

try:
    from DrissionPage.errors import ElementLostError
except Exception:  # pragma: no cover
    ElementLostError = RuntimeError

from vision_ai_recaptcha_solver import constants as _constants
from vision_ai_recaptcha_solver.exceptions import ElementNotFoundError

# Selectors
CHECKBOX_SELECTOR = _constants.CHECKBOX_SELECTOR
VERIFY_BUTTON_SELECTOR = _constants.VERIFY_BUTTON_SELECTOR
RELOAD_BUTTON_SELECTOR = _constants.RELOAD_BUTTON_SELECTOR
SOLVED_CHECKBOX_SELECTOR = _constants.SOLVED_CHECKBOX_SELECTOR
TARGET_TEXT_SELECTOR = _constants.TARGET_TEXT_SELECTOR
IMAGE_CONTAINER_SELECTOR = _constants.IMAGE_CONTAINER_SELECTOR
TILE_SELECTOR_TEMPLATE = _constants.TILE_SELECTOR_TEMPLATE

# Default timeout for all browser operations
DEFAULT_TIMEOUT = _constants.DEFAULT_TIMEOUT


def get_checkbox_iframe(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT * 2,
) -> Any | None:
    """Get the reCAPTCHA checkbox iframe.

    Args:
        browser: DrissionPage browser/tab instance.
        timeout: Maximum time to wait for the iframe.

    Returns:
        Element for the checkbox iframe, or None if not found.
    """
    logger = logging.getLogger("vision_ai_recaptcha_solver")

    tab = _get_tab(browser)

    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            # Find all iframes
            iframes = tab.eles("t:iframe")

            for iframe in iframes:
                title = (iframe.attr("title") or "").lower()
                is_recaptcha = "recaptcha" in title

                if is_recaptcha:
                    return tab.get_frame(iframe)

            time.sleep(0.1)
        except AttributeError as e:
            logger.debug(f"get_checkbox_iframe: AttributeError - {e}")
            time.sleep(0.3)
        except ElementLostError as e:
            logger.debug(f"get_checkbox_iframe: ElementLostError - {e}")
            time.sleep(0.3)
        except (RuntimeError, TimeoutError) as e:
            logger.debug(f"get_checkbox_iframe: Exception - {e}")
            time.sleep(0.3)

    logger.debug("get_checkbox_iframe: No checkbox iframe found within timeout")
    return None


def get_challenge_iframe(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT * 2,
) -> Any | None:
    """Get the reCAPTCHA challenge iframe.

    Args:
        browser: DrissionPage browser/tab instance.
        timeout: Maximum time to wait for the iframe.

    Returns:
        Element for the challenge iframe, or None if not found.
    """
    logger = logging.getLogger("vision_ai_recaptcha_solver")

    tab = _get_tab(browser)

    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            # Find all iframes
            iframes = tab.eles("t:iframe")

            for iframe in iframes:
                title = (iframe.attr("title") or "").lower()

                is_challenge = "challenge" in title

                # Also check if it's the bframe
                src = (iframe.attr("src") or "").lower()
                is_bframe = "bframe" in src

                if is_challenge or is_bframe:
                    frame = tab.get_frame(iframe)
                    if frame:
                        return frame

            time.sleep(0.1)
        except AttributeError as e:
            logger.debug(f"get_challenge_iframe: AttributeError - {e}")
            time.sleep(0.5)
        except ElementLostError as e:
            logger.debug(f"get_challenge_iframe: ElementLostError - {e}")
            time.sleep(0.5)
        except (RuntimeError, TimeoutError) as e:
            logger.debug(f"get_challenge_iframe: Exception during search - {e}")
            time.sleep(0.5)

    return None


def click_checkbox(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT,
) -> None:
    """Click the reCAPTCHA checkbox.

    Args:
        browser: DrissionPage browser/tab instance.
        timeout: Maximum time to wait for the checkbox.

    Raises:
        ElementNotFoundError: If checkbox or iframe not found.
    """
    logger = logging.getLogger("vision_ai_recaptcha_solver")

    iframe = get_checkbox_iframe(browser, timeout)
    if iframe:
        checkbox = iframe.ele(CHECKBOX_SELECTOR, timeout=timeout)
        if checkbox:
            checkbox.click()
        else:
            logger.debug("click_checkbox: Checkbox element not found")
            raise ElementNotFoundError("Checkbox element not found")
    else:
        logger.debug("click_checkbox: Checkbox iframe not found")
        raise ElementNotFoundError("Checkbox iframe not found")


def click_verify_button(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT,
) -> bool:
    """Click the verify button.

    Args:
        browser: DrissionPage browser/tab instance.
        timeout: Maximum time to wait for the button.

    Returns:
        True if clicked successfully, False otherwise.
    """
    logger = logging.getLogger("vision_ai_recaptcha_solver")

    iframe = get_challenge_iframe(browser, timeout)
    if not iframe:
        logger.debug("click_verify_button: No challenge iframe found")
        return False

    try:
        button = iframe.ele(VERIFY_BUTTON_SELECTOR, timeout=timeout)
        if button:
            button.click()
            return True
        else:
            logger.debug("click_verify_button: Verify button not found")
            return False
    except AttributeError as e:
        logger.debug(f"click_verify_button: AttributeError - {e}")
        return False
    except (RuntimeError, TimeoutError, ElementLostError) as e:
        logger.debug(f"click_verify_button: Exception - {e}")
        return False


def click_reload_button(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT,
) -> None:
    """Click the reload button to get a new challenge.

    Args:
        browser: DrissionPage browser/tab instance.
        timeout: Maximum time to wait for the button.
    """
    iframe = get_challenge_iframe(browser, timeout)
    if iframe:
        button = iframe.ele(RELOAD_BUTTON_SELECTOR, timeout=timeout)
        if button:
            button.click()


def is_solved(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT / 2,
) -> bool:
    """Check if the captcha has been solved.

    Args:
        browser: DrissionPage browser/tab instance.
        timeout: Maximum time to wait for the solved indicator.

    Returns:
        True if solved, False otherwise.
    """
    try:
        iframe = get_checkbox_iframe(browser, timeout=timeout)
        if not iframe:
            return False

        # Look for checked checkbox
        solved = iframe.ele(SOLVED_CHECKBOX_SELECTOR, timeout=timeout)
        return solved is not None and bool(solved)

    except (AttributeError, RuntimeError, TimeoutError, ElementLostError):
        return False


def is_verify_button_disabled(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT / 5,
) -> bool:
    """Check if the verify button is currently disabled.

    Args:
        browser: DrissionPage browser instance.
        timeout: Maximum time to wait for the button.

    Returns:
        True if disabled or no verify button, False if enabled.
    """
    try:
        iframe = get_challenge_iframe(browser, timeout)
        if not iframe:
            return False

        button = iframe.ele(VERIFY_BUTTON_SELECTOR, timeout=timeout)
        if not button:
            return False

        disabled = button.attr("disabled")
        return disabled is not None

    except (AttributeError, RuntimeError, TimeoutError, ElementLostError):
        return True


def wait_for_verify_result(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT,
) -> bool:
    """Wait until the verify button is no longer disabled, then check if solved.

    Args:
        browser: DrissionPage browser/tab instance.
        timeout: Maximum time to wait for processing to complete.

    Returns:
        True if captcha was solved, False otherwise.
    """
    logger = logging.getLogger("vision_ai_recaptcha_solver")

    start_time = time.time()

    time.sleep(0.1)

    while time.time() - start_time < timeout:
        # Check if already solved
        if is_solved(browser, timeout=1):
            logger.debug("wait_for_verify_result: Captcha solved!")
            return True

        # Check if verify button is still disabled
        if not is_verify_button_disabled(browser, timeout=1):
            # Button is enabled, processing is done
            logger.debug("wait_for_verify_result: Verify button enabled, checking result...")
            time.sleep(0.2)
            return is_solved(browser, timeout=2)

        logger.debug("wait_for_verify_result: Verify button is still disabled, waiting...")
        time.sleep(0.1)

    logger.debug("wait_for_verify_result: Timeout waiting for verify result")
    return is_solved(browser, timeout=2)


def get_target_keyword(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT,
) -> str | None:
    """Get the target keyword from the captcha challenge text.

    Args:
        browser: DrissionPage browser/tab instance.
        timeout: Maximum time to wait for the element.

    Returns:
        Target keyword, like "bicycle", "bus", or None if not found.
    """
    logger = logging.getLogger("vision_ai_recaptcha_solver")

    try:
        iframe = get_challenge_iframe(browser, timeout)
        if not iframe:
            logger.debug("get_target_keyword: No challenge iframe found")
            return None

        element = iframe.ele(".rc-imageselect-payload", timeout=2).ele("tag:strong", timeout=2)
        if element and hasattr(element, "text") and element.text:
            keyword = str(element.text).strip().lower()
            logger.debug(f"get_target_keyword: Found '{keyword}'")
            return keyword

        logger.debug("get_target_keyword: No target keyword found")
        return None

    except AttributeError as e:
        logger.debug(f"get_target_keyword: AttributeError - {e}")
        return None
    except (RuntimeError, TimeoutError, ElementLostError) as e:
        logger.debug(f"get_target_keyword: Exception - {e}")
        return None


def get_challenge_title(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT,
) -> str:
    """Get the full challenge title text.

    Args:
        browser: DrissionPage browser/tab instance.
        timeout: Maximum time to wait.

    Returns:
        Challenge title text, or empty string if not found.
    """
    logger = logging.getLogger("vision_ai_recaptcha_solver")

    try:
        iframe = get_challenge_iframe(browser, timeout)
        if not iframe:
            logger.debug("get_challenge_title: No challenge iframe found")
            return ""

        element = iframe.ele(".rc-imageselect-instructions", timeout=2)
        if element and hasattr(element, "text") and element.text:
            title = str(element.text)
            logger.debug(f"get_challenge_title: Found '{title[:50]}...'")
            return title

        logger.debug("get_challenge_title: No title found")
        return ""

    except AttributeError as e:
        logger.debug(f"get_challenge_title: AttributeError - {e}")
        return ""
    except (RuntimeError, TimeoutError, ElementLostError) as e:
        logger.debug(f"get_challenge_title: Exception - {e}")
        return ""


def get_captcha_image_urls(
    browser: Any,
    timeout: float = DEFAULT_TIMEOUT,
) -> list[str]:
    """Get all captcha images URLs from the challenge.

    Args:
        browser: DrissionPage browser/tab instance.
        timeout: Maximum time to wait for images.

    Returns:
        List of images URLs.
    """
    logger = logging.getLogger("vision_ai_recaptcha_solver")

    try:
        iframe = get_challenge_iframe(browser, timeout)
        if not iframe:
            logger.debug("get_captcha_image_urls: No challenge iframe found")
            return []

        selectors = [
            IMAGE_CONTAINER_SELECTOR,
            "t:img",
            ".rc-image-tile-wrapper img",
            ".rc-imageselect-tile img",
            "#rc-imageselect-target .rc-image-tile-wrapper img",
        ]

        for selector in selectors:
            try:
                images = iframe.eles(selector)

                if images:
                    urls = []
                    for img in images:
                        src = img.attr("src")
                        # Note: reCAPTCHA images have payload in the URL
                        if src and "payload" in src:
                            urls.append(src)

                    if urls:
                        return urls
            except AttributeError as e:
                logger.debug(f"get_captcha_image_urls: Selector '{selector}' AttributeError - {e}")
                continue
            except (RuntimeError, TimeoutError) as e:
                logger.debug(f"get_captcha_image_urls: Selector '{selector}' failed - {e}")
                continue

        logger.debug("get_captcha_image_urls: No images found with any selector")
        return []

    except AttributeError as e:
        logger.debug(f"get_captcha_image_urls: AttributeError - {e}")
        return []
    except (RuntimeError, TimeoutError, ElementLostError) as e:
        logger.debug(f"get_captcha_image_urls: Exception - {e}")
        return []


def click_tile(
    browser: Any,
    cell: int,
    timeout: float = DEFAULT_TIMEOUT,
) -> bool:
    """Click a specific tile in the captcha grid.

    Args:
        browser: DrissionPage browser/tab instance.
        cell: 1-indexed cell number to click.
        timeout: Maximum time to wait.

    Returns:
        True if clicked successfully, False otherwise.
    """
    logger = logging.getLogger("vision_ai_recaptcha_solver")

    try:
        iframe = get_challenge_iframe(browser, timeout)
        if not iframe:
            logger.debug("click_tile: No challenge iframe")
            return False

        selectors = [
            ".rc-image-tile-wrapper",
            "css:td.rc-imageselect-tile",
            TILE_SELECTOR_TEMPLATE,
        ]

        for selector in selectors:
            try:
                tiles = iframe.eles(selector)

                if tiles and cell <= len(tiles) and cell > 0:
                    tile = tiles[cell - 1]
                    tile.click()
                    logger.debug(f"click_tile: Successfully clicked cell {cell}")
                    return True
            except AttributeError as e:
                logger.debug(f"click_tile: Selector '{selector}' AttributeError - {e}")
                continue
            except (RuntimeError, TimeoutError) as e:
                logger.debug(f"click_tile: Selector '{selector}' failed - {e}")
                continue

        logger.debug(f"click_tile: Could not click cell {cell}")
        return False

    except AttributeError as e:
        logger.debug(f"click_tile: AttributeError - {e}")
        return False
    except (RuntimeError, TimeoutError, ElementLostError) as e:
        logger.debug(f"click_tile: Exception - {e}")
        return False


def _get_tab(browser: Any) -> Any:
    """Extract the tab from the browser.

    The recaptcha_domain_replicator may pass different browser objects.

    Args:
        browser: Browser instance.

    Returns:
        Tab object.
    """
    if hasattr(browser, "latest_tab"):
        return browser.latest_tab

    if hasattr(browser, "tab"):
        return browser.tab

    if hasattr(browser, "ele") and hasattr(browser, "get_frame"):
        return browser

    # Assume browser is the tab itself
    return browser
