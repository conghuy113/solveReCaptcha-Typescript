"""Unit tests for the lightweight ONNX-only inference backend."""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pytest

from vision_ai_recaptcha_solver.detector.yolo_detector import YOLODetector


class FakeSession:
    def __init__(self, output: np.ndarray[Any, Any]) -> None:
        self.output = output
        self.last_feed: dict[str, np.ndarray[Any, Any]] | None = None

    def run(
        self,
        output_names: Any,
        feed: dict[str, np.ndarray[Any, Any]],
    ) -> list[np.ndarray[Any, Any]]:
        self.last_feed = feed
        return [self.output]


def test_classification_uses_batched_rgb_float_tensor() -> None:
    output = np.array([[0.1, 0.8, 0.1], [0.7, 0.2, 0.1]], dtype=np.float32)
    session = FakeSession(output)
    detector = YOLODetector.__new__(YOLODetector)
    detector._classification_model = session
    detector._classification_input = "images"
    detector._class_names = {0: "zero", 1: "one", 2: "two"}

    images = [
        np.full((30, 40, 3), (0, 0, 255), dtype=np.uint8),
        np.full((40, 30, 3), (255, 0, 0), dtype=np.uint8),
    ]
    confidences = detector.get_target_confidences_batch(images, 1)

    assert confidences == pytest.approx([0.8, 0.2])
    assert session.last_feed is not None
    tensor = session.last_feed["images"]
    assert tensor.shape == (2, 3, 640, 640)
    assert tensor.dtype == np.float32
    assert tensor[0, 0].max() == 1.0  # BGR red became the first RGB channel.


def test_detection_decodes_target_box_and_scales_to_source_image() -> None:
    output = np.zeros((1, 84, 1), dtype=np.float32)
    output[0, 0:4, 0] = (320, 320, 320, 320)
    output[0, 4 + 5, 0] = 0.9
    session = FakeSession(output)
    detector = YOLODetector.__new__(YOLODetector)
    detector._detection_model = session
    detector._detection_input = "images"
    detector.detection_conf_threshold = 0.6
    detector.logger = logging.getLogger(__name__)

    image = np.zeros((450, 450, 3), dtype=np.uint8)
    boxes = detector.detect_objects(image, target_class=5)

    assert boxes == [(112, 112, 337, 337)]
    assert session.last_feed is not None
    assert session.last_feed["images"].shape == (1, 3, 640, 640)
