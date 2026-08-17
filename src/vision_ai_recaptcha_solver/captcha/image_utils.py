"""Image processing utilities."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

import cv2
import numpy as np
import requests
from PIL import Image
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from vision_ai_recaptcha_solver.exceptions import ImageDownloadError

if TYPE_CHECKING:
    from numpy.typing import NDArray

logger = logging.getLogger(__name__)


def download_image(
    url: str,
    path: Path,
    retries: int = 5,
    retry_delay: float = 0.2,
    timeout: float = 5.0,
) -> Path:
    """Download an image from a URL to a local path with retry logic.

    Args:
        url: URL of the image to download.
        path: Local path to save the image.
        retries: Number of retry attempts on failure.
        retry_delay: Base delay between retries (exponential backoff applied).
        timeout: Request timeout in seconds.

    Returns:
        The path where the image was saved.

    Raises:
        ImageDownloadError: If download fails after all retries.
    """

    @retry(
        stop=stop_after_attempt(retries + 1),
        wait=wait_exponential(multiplier=retry_delay, min=0.5, max=5),
        retry=retry_if_exception_type(
            (
                requests.ConnectionError,
                requests.Timeout,
                requests.HTTPError,
            )
        ),
        reraise=True,
    )
    def _download() -> Path:
        response = requests.get(url, stream=True, timeout=timeout)
        response.raise_for_status()

        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)

        return path

    try:
        return _download()
    except (requests.RequestException, OSError) as e:
        logger.error(f"Failed to download image from {url}: {e}")
        raise ImageDownloadError(f"Failed to download image after {retries} retries: {e}") from e


def load_image_as_array(path: Path) -> NDArray[np.uint8]:
    """Load an image file as a numpy array in BGR format.

    Args:
        path: Path to the image file.

    Returns:
        Image as a numpy array in BGR format.

    Raises:
        FileNotFoundError: If the image file doesn't exist.
        IOError: If the image cannot be loaded.
    """
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {path}")

    image = cv2.imread(str(path))
    if image is None:
        with Image.open(path) as pil_image:
            rgb_array = np.asarray(pil_image.convert("RGB"))
        # Convert RGB to BGR for consistency
        return cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR).astype(np.uint8)

    return image.astype(np.uint8)


def save_image(image: NDArray[np.uint8], path: Path) -> None:
    """Save a numpy array as an image file.

    Args:
        image: Image as a numpy array in BGR format.
        path: Path to save the image.
    """
    path.parent.mkdir(parents=True, exist_ok=True)

    cv2.imwrite(str(path), image)


def composite_image(
    main: NDArray[np.uint8],
    new: NDArray[np.uint8],
    cell: int,
    grid_cols: int = 3,
) -> NDArray[np.uint8]:
    """Paste a new image onto a main image at a specific grid cell.

    Args:
        main: Main image as numpy array.
        new: New image to paste.
        cell: 1-indexed cell number where to paste.
        grid_cols: Number of columns in the grid.

    Returns:
        Composited image as numpy array.
    """
    result = np.copy(main)

    # Calculate cell dimensions
    grid_rows = grid_cols
    cell_height = main.shape[0] // grid_rows
    cell_width = main.shape[1] // grid_cols

    # Calculate cell position (0-indexed)
    row = (cell - 1) // grid_cols
    col = (cell - 1) % grid_cols

    start_row = row * cell_height
    end_row = start_row + cell_height
    start_col = col * cell_width
    end_col = start_col + cell_width

    # Resize new image to fit cell if necessary
    new_resized: NDArray[np.uint8] = new
    if new.shape[0] != cell_height or new.shape[1] != cell_width:
        new_resized = cv2.resize(new, (cell_width, cell_height)).astype(np.uint8)

    result[start_row:end_row, start_col:end_col] = new_resized

    return result
