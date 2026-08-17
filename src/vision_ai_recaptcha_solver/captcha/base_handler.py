"""Abstract base class for captcha handlers."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from vision_ai_recaptcha_solver.browser.navigation import (
    click_tile,
    get_captcha_image_urls,
)
from vision_ai_recaptcha_solver.captcha.image_utils import download_image, load_image_as_array
from vision_ai_recaptcha_solver.config import SolverConfig
from vision_ai_recaptcha_solver.detector.yolo_detector import YOLODetector
from vision_ai_recaptcha_solver.utils import human_delay as shared_human_delay

if TYPE_CHECKING:
    from numpy.typing import NDArray


class BaseCaptchaHandler(ABC):
    """Abstract base class for handling different captcha types.

    Subclasses implement the specific solving logic for each captcha type
    (dynamic 3x3, selection 3x3, square 4x4).
    """

    def __init__(
        self,
        detector: YOLODetector,
        config: SolverConfig,
        logger: logging.Logger | None = None,
    ) -> None:
        """Initialize the captcha handler.

        Args:
            detector: YOLO detector instance for image analysis.
            config: Solver configuration.
            logger: Logger instance. If None, creates a new one.
        """
        self.detector = detector
        self.config = config
        self.logger = logger or logging.getLogger(__name__)
        self._work_dir = config.download_dir

    @abstractmethod
    def solve(self, browser: Any, target_class: int) -> list[int]:
        """Solve the captcha and return the cells that were clicked.

        Args:
            browser: Browser instance from recaptcha_domain_replicator.
            target_class: YOLO class of the target object.

        Returns:
            List of cell indices that were clicked.
        """
        pass

    def click_cells(self, browser: Any, cells: list[int]) -> None:
        """Click on the specified grid cells.

        Args:
            browser: Browser instance.
            cells: List of 1-indexed cell numbers to click.
        """
        for cell in cells:
            if click_tile(browser, cell, timeout=self.config.default_timeout):
                self.human_delay(0.3, 0.2)
            else:
                self.logger.warning(f"Failed to click cell {cell}")

    def get_image_urls(self, browser: Any) -> list[str]:
        """Get all captcha image URLs from the browser.

        Args:
            browser: Browser instance.

        Returns:
            List of image URLs.
        """
        return get_captcha_image_urls(browser, timeout=self.config.default_timeout)

    def download_main_image(self, url: str) -> tuple[Path, NDArray[np.uint8]]:
        """Download the captcha image and return the path and image as an numpy array.

        Args:
            url: URL of the image.

        Returns:
            Tuple of (path, image_array).
        """
        self._work_dir.mkdir(parents=True, exist_ok=True)
        path = self._work_dir / "main.png"
        download_image(
            url,
            path,
            retries=self.config.image_download_retries,
            retry_delay=self.config.image_download_retry_delay,
        )
        image = load_image_as_array(path)
        return path, image

    def human_delay(self, mean: float | None = None, sigma: float | None = None) -> None:
        """Add a random human like delay.

        Args:
            mean: Mean delay in seconds. Uses config default if None.
            sigma: Standard deviation. Uses config default if None.
        """
        mu = self.config.human_delay_mean if mean is None else mean
        sig = self.config.human_delay_sigma if sigma is None else sigma
        shared_human_delay(mean=mu, sigma=sig)
