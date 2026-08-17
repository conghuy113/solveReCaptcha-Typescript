"""Handler for 4x4 square captchas using YOLO detection."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from vision_ai_recaptcha_solver.browser.navigation import get_target_keyword
from vision_ai_recaptcha_solver.captcha.base_handler import BaseCaptchaHandler
from vision_ai_recaptcha_solver.types import CaptchaType

if TYPE_CHECKING:
    pass


class SquareCaptchaHandler(BaseCaptchaHandler):
    """Handler for 4x4 square captchas using object detection.

    Uses YOLO detection model to detect all instances of the target object
    across the full captcha image, then selects all grid cells that contain
    the detected objects.
    """

    captcha_type = CaptchaType.SQUARE_4X4

    GRID_SIZE = 450

    def solve(self, browser: Any, target_class: int) -> list[int]:
        """Solve a square 4x4 captcha using object detection.

        Uses the YOLO detection model to find all instances of the target
        across the full image, then maps detected bounding boxes to grid cells.

        Args:
            browser: Browser instance from recaptcha_domain_replicator.
            target_class: COCO class index.

        Returns:
            List of cells that were clicked.
        """
        # Get target keyword and map to COCO class for detection
        keyword = get_target_keyword(browser)
        if not keyword:
            self.logger.warning("Could not extract target keyword")
            return []

        coco_class = self.detector.get_coco_target_class(keyword)
        if coco_class is None:
            self.logger.critical(f"Unknown target for detection: {keyword}")
            return []

        self.logger.debug(f"Target: '{keyword}' -> COCO class {coco_class}")

        # Get image URLs and download main image
        img_urls = self.get_image_urls(browser)
        if not img_urls:
            self.logger.warning("No captcha images found")
            return []

        _, main_image = self.download_main_image(img_urls[0])

        # Detect targets using full-image detection and map to grid cells
        answers = self.detector.detect_for_grid(
            main_image,
            target_class=coco_class,
            grid_size=self.GRID_SIZE,
        )

        if not answers:
            self.logger.info("No targets detected")
            return []

        # Filter to valid cell range (1-16)
        valid_answers = [a for a in answers if 1 <= a <= 16]

        if not valid_answers:
            self.logger.info("No valid targets in grid")
            return []

        self.logger.info(f"Targets detected in cells: {valid_answers}")

        self.click_cells(browser, sorted(valid_answers, reverse=True))
        self.human_delay(0.1, 0.2)

        return valid_answers
