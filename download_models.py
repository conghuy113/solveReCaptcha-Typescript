"""Download the solver models into the shared Docker volume."""

from __future__ import annotations

import os
from pathlib import Path

from ultralytics import YOLO

from vision_ai_recaptcha_solver.detector.yolo_detector import YOLODetector


MODEL_DIR = Path(os.environ.get("MODEL_DIR", "/models"))
CLASSIFICATION_MODEL = MODEL_DIR / "recaptcha_classification_57k.onnx"
DETECTION_MODEL = MODEL_DIR / "yolo12x.pt"


def main() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    if CLASSIFICATION_MODEL.is_file():
        print(f"Classification model already exists: {CLASSIFICATION_MODEL}")
    else:
        print("Downloading classification model...")
        YOLODetector._download_model(CLASSIFICATION_MODEL)

    if DETECTION_MODEL.is_file():
        print(f"Detection model already exists: {DETECTION_MODEL}")
    else:
        print("Downloading detection model...")
        previous_directory = Path.cwd()
        try:
            os.chdir(MODEL_DIR)
            YOLO(DETECTION_MODEL.name, task="detect", verbose=False)
        finally:
            os.chdir(previous_directory)

    if not DETECTION_MODEL.is_file():
        raise RuntimeError(f"Detection model was not created at {DETECTION_MODEL}")

    print("Both Python models are ready.")


if __name__ == "__main__":
    main()
