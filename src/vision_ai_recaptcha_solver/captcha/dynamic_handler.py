"""Handler for dynamic 3x3 captchas, where new images appear after selection."""

from __future__ import annotations

import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from vision_ai_recaptcha_solver.captcha.base_handler import BaseCaptchaHandler
from vision_ai_recaptcha_solver.captcha.image_utils import (
    composite_image,
    download_image,
    load_image_as_array,
    save_image,
)
from vision_ai_recaptcha_solver.exceptions import ImageDownloadError, LowConfidenceError
from vision_ai_recaptcha_solver.types import CaptchaType

if TYPE_CHECKING:
    from numpy.typing import NDArray


class DynamicCaptchaHandler(BaseCaptchaHandler):
    """Handler for 3x3 dynamic captchas.

    The handler continues clicking until no more target objects are detected.

    Tiles that don't match the target are cached and not re-analyzed.
    """

    captcha_type = CaptchaType.DYNAMIC_3X3

    def solve(self, browser: Any, target_class: int) -> list[int]:
        """Solve a dynamic 3x3 captcha.

        Note: Initial detection uses ranking based selection (top 3 + optional 4th).
        If any of the top 3 has confidence below min_confidence_threshold, raises error.
        Subsequent rounds use standard detection with conf_threshold.

        Args:
            browser: Browser instance from recaptcha_domain_replicator.
            target_class: YOLO class index of the target object.

        Returns:
            List of all cells that were clicked during solving.

        Raises:
            LowConfidenceError: If any top 3 cell has confidence below minimum threshold.
        """
        all_clicked: list[int] = []

        non_matching_cache: set[int] = set()

        # Get initial image URLs and download the main image
        img_urls = self.get_image_urls(browser)
        if not img_urls:
            self.logger.warning("No captcha images found")
            return all_clicked

        unique_urls = list(dict.fromkeys(img_urls))

        # There's one combined image (300x300)
        main_path, main_image = self.download_main_image(unique_urls[0])

        # Initial detection, with ranking selection
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

        # Cells not in answers are non-matching for subsequent rounds
        for cell, _ in ranked:
            if cell not in answers:
                non_matching_cache.add(cell)

        # Click initial answers
        self.click_cells(browser, answers)
        all_clicked.extend(answers)

        # Continue processing new images
        previous_urls = img_urls.copy()

        while True:
            # Wait for new images to load (bounded by default_timeout)
            poll_deadline = time.time() + self.config.default_timeout / 3
            current_urls = previous_urls
            is_new = False

            while time.time() < poll_deadline:
                time.sleep(0.3)
                is_new, current_urls = self._check_for_new_images(browser, answers, previous_urls)
                if is_new:
                    break

            if not is_new:
                self.logger.debug("No new images detected within timeout, finishing")
                break

            # Download and composite new images only for clicked cells
            main_image = self._update_main_image(main_path, main_image, answers, current_urls)

            # Only re-analyze the cells that were clicked
            for cell in answers:
                non_matching_cache.discard(cell)

            tiles_to_analyze = set(answers)

            answers = self._detect_with_cache(
                main_image, target_class, non_matching_cache, tiles_to_analyze
            )

            if not answers:
                self.logger.debug("No more targets detected")
                break

            self.logger.info(f"New targets detected in cells: {answers}")

            # Click new answers
            self.click_cells(browser, answers)
            all_clicked.extend(answers)

            previous_urls = current_urls

            self.human_delay(0.3, 0.2)

        return all_clicked

    def _detect_with_cache(
        self,
        image: NDArray[np.uint8],
        target_class: int,
        non_matching_cache: set[int],
        tiles_to_analyze: set[int],
    ) -> list[int]:
        """Detect targets only in specified tiles, using cache to skip known non-matches.

        Uses batch prediction for parallel processing of all tiles at once.

        Args:
            image: The main captcha image.
            target_class: Class index of the target.
            non_matching_cache: Set of cell numbers (1-indexed) known to not match.
            tiles_to_analyze: Set of cell numbers (1-indexed) to analyze.

        Returns:
            List of cell numbers containing the target.
        """
        img_height, img_width = image.shape[:2]
        grid_size = 3
        tile_h = img_height // grid_size
        tile_w = img_width // grid_size

        conf_threshold = self.config.conf_threshold

        # Extract tiles that need to be analyzed
        tiles: list[NDArray[np.uint8]] = []
        cell_nums_to_predict: list[int] = []

        for row in range(grid_size):
            for col in range(grid_size):
                cell_num = row * grid_size + col + 1

                # Skip tiles in non_matching_cache
                if cell_num in non_matching_cache:
                    self.logger.debug(f"Tile {cell_num}: CACHED (non-match, skipped)")
                    continue

                if cell_num not in tiles_to_analyze:
                    continue

                # Extract tile
                y1 = row * tile_h
                y2 = (row + 1) * tile_h
                x1 = col * tile_w
                x2 = (col + 1) * tile_w
                tile = np.ascontiguousarray(image[y1:y2, x1:x2])

                tiles.append(tile)
                cell_nums_to_predict.append(cell_num)

        if not tiles:
            return []

        # Batch prediction
        confidences = self.detector.get_target_confidences_batch(tiles, target_class)

        # Process results
        answers = []
        for cell_num, target_conf in zip(cell_nums_to_predict, confidences, strict=True):
            if target_conf >= conf_threshold:
                self.logger.debug(f"Tile {cell_num}: target conf {target_conf:.2f} SUCCESS TARGET")
                answers.append(cell_num)
            else:
                self.logger.debug(f"Tile {cell_num}: target conf {target_conf:.2f}")
                non_matching_cache.add(cell_num)

        return answers

    def _check_for_new_images(
        self,
        browser: Any,
        clicked_cells: list[int],
        previous_urls: list[str],
    ) -> tuple[bool, list[str]]:
        """Check if new images have loaded in the clicked cells.

        Args:
            browser: Browser instance.
            clicked_cells: Cells that were clicked.
            previous_urls: Previous image URLs.

        Returns:
            Tuple of (has_new_images, current_urls).
        """
        try:
            current_urls = self.get_image_urls(browser)

            if len(current_urls) != len(previous_urls):
                return False, current_urls

            # Check if clicked cells have new URLs
            for cell in clicked_cells:
                idx = cell - 1
                if (
                    idx < len(current_urls)
                    and idx < len(previous_urls)
                    and current_urls[idx] == previous_urls[idx]
                ):
                    # This cell hasn't updated yet
                    return False, current_urls

            return True, current_urls

        except (AttributeError, IndexError) as e:
            self.logger.debug(f"Error checking for new images: {e}")
            return False, previous_urls

    def _update_main_image(
        self,
        main_path: Path,
        main_image: NDArray[np.uint8],
        cells: list[int],
        current_urls: list[str],
    ) -> NDArray[np.uint8]:
        """Download new cell images and composite them onto the main image.

        Args:
            main_path: Path to the main image.
            main_image: Current main image array.
            cells: Cells that have new images.
            current_urls: Current image URLs.

        Returns:
            Updated main image array.
        """
        updated_image = main_image

        for cell in cells:
            idx = cell - 1
            if idx >= len(current_urls):
                continue

            # Download new cell image
            cell_path = self._work_dir / f"cell_{cell}.png"
            try:
                download_image(
                    current_urls[idx],
                    cell_path,
                    retries=self.config.image_download_retries,
                    retry_delay=self.config.image_download_retry_delay,
                )
                new_image = load_image_as_array(cell_path)

                # Composite onto main image
                updated_image = composite_image(updated_image, new_image, cell, grid_cols=3)

            except ImageDownloadError as e:
                self.logger.warning(f"Failed to download cell {cell} image: {e}")
                continue
            except (FileNotFoundError, OSError) as e:
                self.logger.warning(f"Failed to update cell {cell}: {e}")
                continue

        # Save updated main image
        save_image(updated_image, main_path)

        return updated_image
