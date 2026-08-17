"""Grid calculation utilities for captcha cell positioning."""

from __future__ import annotations


def calculate_3x3_cell(x: float, y: float, grid_size: int = 300) -> int:
    """Calculate the 1-indexed cell number for a point in a 3x3 grid.

    Args:
        x: X coordinate of the point.
        y: Y coordinate of the point.
        grid_size: Total size of the grid in pixels.

    Returns:
        Cell number from 1 to 9.
    """
    if grid_size <= 0:
        raise ValueError(f"grid_size must be positive, got {grid_size}")
    cell_size = grid_size / 3
    row = int(y // cell_size)
    col = int(x // cell_size)

    # Clamp to valid range
    row = max(0, min(2, row))
    col = max(0, min(2, col))

    return row * 3 + col + 1


def calculate_4x4_cells(
    bbox: tuple[int, int, int, int],
    grid_size: int = 450,
) -> list[int]:
    """Calculate all 1-indexed cells occupied by a bounding box in a 4x4 grid.

    Args:
        bbox: Bounding box as (x1, y1, x2, y2).
        grid_size: Total size of the grid in pixels.

    Returns:
        Sorted list of cell numbers from 1 to 16.
    """
    if grid_size <= 0:
        raise ValueError(f"grid_size must be positive, got {grid_size}")
    x1, y1, x2, y2 = bbox
    cell_size = grid_size / 4

    # Get the four corners
    corners = [(x1, y1), (x2, y1), (x1, y2), (x2, y2)]
    corner_cells = []

    for x, y in corners:
        cell = _point_to_4x4_cell(x, y, cell_size)
        if cell is not None:
            corner_cells.append(cell)

    if not corner_cells:
        return []

    return get_occupied_cells(corner_cells, grid_cols=4)


def _point_to_4x4_cell(x: float, y: float, cell_size: float) -> int | None:
    """Map a point to a cell in a 4x4 grid.

    Args:
        x: X coordinate.
        y: Y coordinate.
        cell_size: Size of each cell.

    Returns:
        Cell number from 1 to 16, or None if out of bounds.
    """
    grid_size = cell_size * 4

    if x < 0 or x > grid_size or y < 0 or y > grid_size:
        return None

    col = min(3, int(x // cell_size))
    row = min(3, int(y // cell_size))

    return row * 4 + col + 1


def get_occupied_cells(vertices: list[int], grid_cols: int = 4) -> list[int]:
    """Get all cells occupied by a shape defined by corner vertices.

    Given the cells containing the corners of a bounding box, returns all cells
    that the box spans (including cells between corners).

    Args:
        vertices: List of cell numbers containing the corners.
        grid_cols: Number of columns in the grid.

    Returns:
        Sorted list of all occupied cell numbers.
    """
    if not vertices:
        return []

    # Convert cells to (row, col) coordinates
    coords = [((v - 1) // grid_cols, (v - 1) % grid_cols) for v in vertices]
    rows, cols = zip(*coords, strict=True)

    min_row, max_row = min(rows), max(rows)
    min_col, max_col = min(cols), max(cols)

    occupied = set()
    for row in range(min_row, max_row + 1):
        for col in range(min_col, max_col + 1):
            occupied.add(row * grid_cols + col + 1)

    return sorted(occupied)
