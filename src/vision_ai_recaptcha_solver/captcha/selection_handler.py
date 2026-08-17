"""Handler for one-time selection 3x3 captchas."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from vision_ai_recaptcha_solver.captcha.base_handler import BaseCaptchaHandler
from vision_ai_recaptcha_solver.exceptions import LowConfidenceError
from vision_ai_recaptcha_solver.types import CaptchaType

if TYPE_CHECKING:
    pass


class SelectionCaptchaHandler(BaseCaptchaHandler):
    """Handler for 3x3 one-time selection captchas.

    In selection captchas, the user selects all matching images at once
    and then verifies.
    """

    captcha_type = CaptchaType.SELECTION_3X3

    def solve(self, browser: Any, target_class: int) -> list[int]:
        """Solve a selection 3x3 captcha.

        Uses ranking based selection, always click top 3 cells by target confidence,
        plus a 4th cell if its confidence >= fourth_cell_threshold.

        If any of the top 3 cells has confidence below min_confidence_threshold,
        raises LowConfidenceError to trigger a reload.

        Args:
            browser: Browser instance from recaptcha_domain_replicator.
            target_class: YOLO class index of the target object.

        Returns:
            List of cells that were clicked.

        Raises:
            LowConfidenceError: If any top 3 cell has confidence below minimum threshold.
        """
        img_urls = self.get_image_urls(browser)
        if not img_urls:
            self.logger.warning("No captcha images found")
            return []

        unique_urls = list(dict.fromkeys(img_urls))
        self.logger.debug(f"Found {len(img_urls)} image URLs, {len(unique_urls)} unique")

        # Download the combined 3x3 grid image
        _, main_image = self.download_main_image(unique_urls[0])

        # Get all cells with their target confidences
        cell_confidences = self.detector.classify_tiles_with_confidence(
            main_image, grid_size=3, target_class=target_class
        )

        # Rank by confidence
        ranked = sorted(cell_confidences, key=lambda x: x[1], reverse=True)

        # Check minimum confidence threshold for top 3 cells
        min_threshold = self.config.min_confidence_threshold
        for i, (cell, conf) in enumerate(ranked[:3]):
            if conf < min_threshold:
                self.logger.info(
                    f"Cell {cell} (rank {i + 1}) has confidence {conf:.2f} "
                    f"below minimum threshold {min_threshold:.2f}"
                )
                raise LowConfidenceError(
                    f"Top cell confidence {conf:.2f} is below minimum {min_threshold:.2f}"
                )

        # Always select top 3
        answers = [cell for cell, _ in ranked[:3]]

        # Add 4th cell if confidence >= fourth_cell_threshold
        if len(ranked) >= 4:
            fourth_cell, fourth_conf = ranked[3]
            if fourth_conf >= self.config.fourth_cell_threshold:
                answers.append(fourth_cell)
                self.logger.debug(f"Including 4th cell {fourth_cell} with conf {fourth_conf:.2f}")

        self.click_cells(browser, answers)
        self.human_delay(0.3, 0.2)
        return answers
