"""Tests for grid calculation utilities."""

from __future__ import annotations

import pytest

from vision_ai_recaptcha_solver.detector.grid_utils import (
    calculate_3x3_cell,
    calculate_4x4_cells,
    get_occupied_cells,
)


class TestCalculate3x3Cell:
    """Tests for calculate_3x3_cell function."""

    def test_top_left_cell(self) -> None:
        """Test detection in top-left cell (cell 1)."""
        # Center of cell 1: (50, 50)
        assert calculate_3x3_cell(50, 50, grid_size=300) == 1

    def test_top_center_cell(self) -> None:
        """Test detection in top-center cell (cell 2)."""
        # Center of cell 2: (150, 50)
        assert calculate_3x3_cell(150, 50, grid_size=300) == 2

    def test_top_right_cell(self) -> None:
        """Test detection in top-right cell (cell 3)."""
        # Center of cell 3: (250, 50)
        assert calculate_3x3_cell(250, 50, grid_size=300) == 3

    def test_middle_left_cell(self) -> None:
        """Test detection in middle-left cell (cell 4)."""
        assert calculate_3x3_cell(50, 150, grid_size=300) == 4

    def test_center_cell(self) -> None:
        """Test detection in center cell (cell 5)."""
        assert calculate_3x3_cell(150, 150, grid_size=300) == 5

    def test_bottom_right_cell(self) -> None:
        """Test detection in bottom-right cell (cell 9)."""
        assert calculate_3x3_cell(250, 250, grid_size=300) == 9

    def test_edge_values(self) -> None:
        """Test values at cell edges."""
        # At the boundary between cell 1 and 2
        assert calculate_3x3_cell(100, 50, grid_size=300) == 2

    def test_clamping_out_of_bounds(self) -> None:
        """Test that out-of-bounds values are clamped."""
        # Very large values should clamp to bottom-right
        assert calculate_3x3_cell(500, 500, grid_size=300) == 9

    def test_invalid_grid_size(self) -> None:
        """Grid size must be positive."""
        with pytest.raises(ValueError):
            calculate_3x3_cell(10, 10, grid_size=0)


class TestCalculate4x4Cells:
    """Tests for calculate_4x4_cells function."""

    def test_single_cell_bbox(self) -> None:
        """Test a bounding box contained in a single cell."""
        # Bbox in top-left cell
        bbox = (10, 10, 100, 100)
        cells = calculate_4x4_cells(bbox, grid_size=450)
        assert cells == [1]

    def test_spanning_two_cells_horizontally(self) -> None:
        """Test a bbox spanning two cells horizontally."""
        # Bbox spanning cells 1 and 2
        bbox = (50, 20, 150, 80)
        cells = calculate_4x4_cells(bbox, grid_size=450)
        assert 1 in cells
        assert 2 in cells

    def test_spanning_four_cells(self) -> None:
        """Test a bbox spanning four cells (2x2)."""
        # Bbox spanning cells 1, 2, 5, 6
        bbox = (50, 50, 170, 170)
        cells = calculate_4x4_cells(bbox, grid_size=450)
        assert set(cells) == {1, 2, 5, 6}

    def test_bottom_right_corner(self) -> None:
        """Test a bbox in the bottom-right corner."""
        bbox = (380, 380, 440, 440)
        cells = calculate_4x4_cells(bbox, grid_size=450)
        assert cells == [16]

    def test_invalid_grid_size(self) -> None:
        """Grid size must be positive."""
        with pytest.raises(ValueError):
            calculate_4x4_cells((0, 0, 10, 10), grid_size=-1)


class TestGetOccupiedCells:
    """Tests for get_occupied_cells function."""

    def test_single_vertex(self) -> None:
        """Test with a single vertex."""
        cells = get_occupied_cells([5], grid_cols=4)
        assert cells == [5]

    def test_adjacent_vertices_horizontal(self) -> None:
        """Test with horizontally adjacent vertices."""
        cells = get_occupied_cells([1, 2], grid_cols=4)
        assert cells == [1, 2]

    def test_adjacent_vertices_vertical(self) -> None:
        """Test with vertically adjacent vertices."""
        cells = get_occupied_cells([1, 5], grid_cols=4)
        assert cells == [1, 5]

    def test_diagonal_vertices_fill_square(self) -> None:
        """Test that diagonal vertices fill the square between them."""
        # Vertices at corners of a 2x2 square
        cells = get_occupied_cells([1, 6], grid_cols=4)
        assert set(cells) == {1, 2, 5, 6}

    def test_empty_vertices(self) -> None:
        """Test with empty vertex list."""
        cells = get_occupied_cells([], grid_cols=4)
        assert cells == []

    def test_three_by_three_grid(self) -> None:
        """Test with 3x3 grid."""
        cells = get_occupied_cells([1, 9], grid_cols=3)
        assert set(cells) == {1, 2, 3, 4, 5, 6, 7, 8, 9}
