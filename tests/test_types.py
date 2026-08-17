"""Tests for type definitions."""

from __future__ import annotations

import pytest

from vision_ai_recaptcha_solver.types import (
    TARGET_MAPPINGS,
    CaptchaType,
    SolveResult,
)


class TestCaptchaType:
    """Tests for CaptchaType enum."""

    def test_enum_values(self) -> None:
        """Test that all expected enum values exist."""
        assert CaptchaType.DYNAMIC_3X3.value == "dynamic_3x3"
        assert CaptchaType.SELECTION_3X3.value == "selection_3x3"
        assert CaptchaType.SQUARE_4X4.value == "square_4x4"
        assert CaptchaType.UNKNOWN.value == "unknown"


class TestSolveResult:
    """Tests for SolveResult dataclass."""

    def test_immutability(self) -> None:
        """Test that SolveResult is immutable (frozen)."""
        result = SolveResult(
            token="token",
            cookies=[],
            time_taken=1.0,
            captcha_type=CaptchaType.UNKNOWN,
            attempts=1,
        )

        with pytest.raises(AttributeError):
            result.token = "new_token" # type: ignore


class TestTargetMappings:
    """Tests for TARGET_MAPPINGS constant."""

    def test_expected_targets_exist(self) -> None:
        """Test that all expected target keywords exist."""
        expected_targets = [
            "bicycle",
            "bridge",
            "bus",
            "car",
            "chimney",
            "crosswalk",
            "hydrant",
            "motorcycle",
            "mountain",
            "palm",
            "stair",
            "tractor",
            "traffic light",
        ]

        for target in expected_targets: assert target in TARGET_MAPPINGS

    def test_expected_target_class_ids(self) -> None:
        """Test that key targets map to the expected model class IDs."""
        expected = {
            "bicycle": 0,
            "bridge": 1,
            "bus": 2,
            "car": 3,
            "chimney": 4,
            "crosswalk": 5,
            "hydrant": 6,
            "motorcycle": 7,
            "mountain": 8,
            "palm": 10,
            "stair": 11,
            "tractor": 12,
            "traffic light": 13,
        }

        for keyword, class_id in expected.items():
            assert TARGET_MAPPINGS[keyword] == class_id

    def test_mapping_values_are_integers(self) -> None:
        """Test that all mapping values are integers and greater than 0."""
        for keyword, class_id in TARGET_MAPPINGS.items():
            assert isinstance(keyword, str)
            assert isinstance(class_id, int)
            assert class_id >= 0
