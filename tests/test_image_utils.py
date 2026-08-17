"""Tests for image utilities."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from vision_ai_recaptcha_solver.captcha.image_utils import (
    composite_image,
    download_image,
    load_image_as_array,
    save_image,
)
from vision_ai_recaptcha_solver.exceptions import ImageDownloadError


class TestDownloadImage:
    """Tests for download_image function."""

    @patch("vision_ai_recaptcha_solver.captcha.image_utils.requests.get")
    def test_successful_download(self, mock_get: MagicMock, tmp_path: Path) -> None:
        """Test successful image download."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.iter_content = MagicMock(return_value=[b"image_data"])
        mock_get.return_value = mock_response

        path = tmp_path / "test.png"
        result = download_image("https://lorempics.com/350", path, retries=0)

        assert result == path
        assert path.exists()
        mock_get.assert_called_once()

    @patch("vision_ai_recaptcha_solver.captcha.image_utils.requests.get")
    def test_download_creates_parent_directories(self, mock_get: MagicMock, tmp_path: Path) -> None:
        """Test that download creates parent directories."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.iter_content = MagicMock(return_value=[b"data"])
        mock_get.return_value = mock_response

        path = tmp_path / "subdir" / "nested" / "image.png"
        download_image("https://lorempics.com/350", path, retries=0)

        assert path.exists()
        assert path.parent.exists()

    @patch("vision_ai_recaptcha_solver.captcha.image_utils.requests.get")
    def test_download_retries_on_failure(self, mock_get: MagicMock, tmp_path: Path) -> None:
        """Test that download retries on connection errors."""
        import requests
        
        # First two calls fail, third succeeds
        mock_get.side_effect = [
            requests.ConnectionError("Connection failed"),
            requests.ConnectionError("Connection failed"),
            MagicMock(
                raise_for_status=MagicMock(),
                iter_content=MagicMock(return_value=[b"data"])
            ),
        ]

        path = tmp_path / "test.png"
        result = download_image("https://lorempics.com/350", path, retries=3)

        assert result == path
        assert mock_get.call_count == 3

    @patch("vision_ai_recaptcha_solver.captcha.image_utils.requests.get")
    def test_download_raises_after_retries_exhausted(
        self, mock_get: MagicMock, tmp_path: Path
    ) -> None:
        """Test that ImageDownloadError is raised after retries exhausted."""
        import requests
        
        mock_get.side_effect = requests.ConnectionError("Connection failed")

        path = tmp_path / "test.png"
        
        with pytest.raises(ImageDownloadError, match="Failed to download image"):
            download_image("https://lorempics.com/350", path, retries=2)


class TestLoadImageAsArray:
    """Tests for load_image_as_array function."""

    def test_file_not_found_raises_error(self) -> None:
        """Test that FileNotFoundError is raised for missing files."""
        with pytest.raises(FileNotFoundError, match="Image not found"):
            load_image_as_array(Path("nonexistent.png"))


class TestCompositeImage:
    """Tests for composite_image function."""

    def test_composite_3x3_grid(self) -> None:
        """Test compositing image onto 3x3 grid."""
        # Create a 300x300 main image (black)
        main = np.zeros((300, 300, 3), dtype=np.uint8)
        
        # Create a 100x100 new image (white)
        new = np.ones((100, 100, 3), dtype=np.uint8) * 255

        # Composite at cell 5 (center)
        result = composite_image(main, new, cell=5, grid_cols=3)

        # Cell 5 is at row 1, col 1 (0-indexed)
        assert np.all(result[100:200, 100:200] == 255)
        assert np.all(result[0:100, 0:100] == 0)

    def test_composite_different_cells(self) -> None:
        """Test compositing at different cell positions."""
        main = np.zeros((300, 300, 3), dtype=np.uint8)
        new = np.ones((100, 100, 3), dtype=np.uint8) * 255

        # Test cell 1 (top-left)
        result = composite_image(main, new, cell=1, grid_cols=3)
        assert np.all(result[0:100, 0:100] == 255)

        # Test cell 9 (bottom-right)
        main = np.zeros((300, 300, 3), dtype=np.uint8)
        result = composite_image(main, new, cell=9, grid_cols=3)
        assert np.all(result[200:300, 200:300] == 255)

    def test_composite_resizes_new_image(self) -> None:
        """Test that new image is resized if dimensions don't match."""
        main = np.zeros((300, 300, 3), dtype=np.uint8)
        # New image is different size
        new = np.ones((50, 50, 3), dtype=np.uint8) * 255

        # Should not raise error and should resize
        result = composite_image(main, new, cell=1, grid_cols=3)
        
        # The cell should be filled
        assert result.shape == (300, 300, 3)


class TestSaveImage:
    """Tests for save_image function."""

    def test_save_creates_parent_directories(self, tmp_path: Path) -> None:
        """Test that save creates parent directories."""
        image = np.zeros((100, 100, 3), dtype=np.uint8)
        path = tmp_path / "subdir" / "image.png"

        save_image(image, path)

        assert path.exists()
        assert path.parent.exists()

    def test_save_bgr_image(self, tmp_path: Path) -> None:
        """Test saving BGR image (OpenCV convention)."""
        image = np.zeros((100, 100, 3), dtype=np.uint8)
        image[:, :, 2] = 255  # Red channel in BGR format
        path = tmp_path / "bgr.png"

        save_image(image, path)

        assert path.exists()
