"""YOLO models for captcha image detection."""

from __future__ import annotations

import ast
import contextlib
import hashlib
import logging
import urllib.request
from collections.abc import Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from typing import TYPE_CHECKING

import cv2
import numpy as np
import onnxruntime as ort

from vision_ai_recaptcha_solver.detector.grid_utils import calculate_4x4_cells
from vision_ai_recaptcha_solver.exceptions import DetectionError, ModelNotFoundError
from vision_ai_recaptcha_solver.types import (
    COCO_TARGET_MAPPINGS,
    TARGET_MAPPINGS,
    CaptchaType,
    DetectionResult,
)

if TYPE_CHECKING:
    from numpy.typing import NDArray


class YOLODetector:
    """Detector for reCAPTCHA challenges using YOLO models.

    Uses classification model for 3x3 captchas and detection model for 4x4 square captchas.
    """

    DEFAULT_DETECTION_MODEL = "yolo12x.onnx"

    # Classification model download URL
    MODEL_DOWNLOAD_URL = "https://huggingface.co/DannyLuna/recaptcha-classification-57k/resolve/main/recaptcha_classification_57k.onnx?download=true"
    MODEL_SHA256 = "4092e8917ee8c2963895d66ba10a97d6ef975c468a95858a8a7bd9e70681b65d"

    def __init__(
        self,
        model_path: Path | str | None = None,
        detection_model_path: Path | str | None = None,
        verbose: bool = False,
        logger: logging.Logger | None = None,
        conf_threshold: float = 0.7,
        fourth_cell_threshold: float = 0.7,
        detection_conf_threshold: float = 0.6,
    ) -> None:
        """Initialize the detector with both classification and detection models.

        Args:
            model_path: Path to the classification model. If None, uses bundled model.
            detection_model_path: Path to the exported detection ONNX model.
            verbose: Whether to enable verbose inference logging.
            logger: Logger instance. If None, creates a new one.
            conf_threshold: Confidence threshold for tile classification.
            fourth_cell_threshold: Threshold to include a 4th cell in selection.
            detection_conf_threshold: Confidence threshold for 4x4 detection model.
        """
        self.model_path = Path(model_path) if model_path else self.get_model_path()
        self.detection_model_path = Path(detection_model_path or self.DEFAULT_DETECTION_MODEL)
        self.verbose = verbose
        self.logger = logger or logging.getLogger(__name__)

        # Store threshold configuration
        self.conf_threshold = conf_threshold
        self.fourth_cell_threshold = fourth_cell_threshold
        self.detection_conf_threshold = detection_conf_threshold

        # Warmup state tracking
        self._warmup_lock = Lock()
        self._warmup_complete = False
        self._warmup_future: Future[None] | None = None
        self._executor: ThreadPoolExecutor | None = None

        # Load classification model
        if not self.model_path.exists():
            raise ModelNotFoundError(f"Classification model not found at: {self.model_path}")

        self.logger.debug(f"Loading YOLO classification model from: {self.model_path}")
        self._classification_model = self._create_session(self.model_path)
        self._classification_input = self._classification_model.get_inputs()[0].name
        self._class_names = self._read_class_names(self._classification_model)
        self.logger.debug(f"Classification model classes: {self._class_names}")

        # Load detection model
        if not self.detection_model_path.exists():
            raise ModelNotFoundError(f"Detection model not found at: {self.detection_model_path}")
        self.logger.debug(f"Loading YOLO detection model: {self.detection_model_path}")
        self._detection_model = self._create_session(self.detection_model_path)
        self._detection_input = self._detection_model.get_inputs()[0].name
        self.logger.debug("Detection model loaded successfully")

        # Start warmup in background
        self.start_warmup_background()

    @staticmethod
    def _create_session(model_path: Path) -> ort.InferenceSession:
        options = ort.SessionOptions()
        options.log_severity_level = 3
        try:
            return ort.InferenceSession(
                str(model_path),
                sess_options=options,
                providers=["CPUExecutionProvider"],
            )
        except Exception as error:
            raise ModelNotFoundError(
                f"Failed to load ONNX model '{model_path}': {error}"
            ) from error

    @staticmethod
    def _read_class_names(session: ort.InferenceSession) -> dict[int, str]:
        raw_names = session.get_modelmeta().custom_metadata_map.get("names", "{}")
        try:
            parsed = ast.literal_eval(raw_names)
        except (SyntaxError, ValueError) as error:
            raise ModelNotFoundError(
                "Classification ONNX metadata has invalid class names"
            ) from error
        if not isinstance(parsed, dict):
            raise ModelNotFoundError("Classification ONNX metadata has no class names")
        return {int(index): str(name) for index, name in parsed.items()}

    def __del__(self) -> None:
        """Cleanup resources when the detector is garbage collected."""
        self._cleanup_executor()

    @contextlib.contextmanager
    def _suppress_third_party_logs(self) -> Iterator[None]:
        """Suppress noisy third party logs when not verbose."""
        if self.verbose:
            yield
            return

        logger_names = ("onnxruntime",)
        prior_levels: list[tuple[logging.Logger, int]] = []

        for name in logger_names:
            logger = logging.getLogger(name)
            prior_levels.append((logger, logger.level))
            logger.setLevel(logging.WARNING)

        try:
            yield
        finally:
            for logger, level in prior_levels:
                logger.setLevel(level)

    def _cleanup_executor(self) -> None:
        """Safely cleanup the thread pool executor."""
        executor = getattr(self, "_executor", None)
        if executor is not None:
            with contextlib.suppress(Exception):
                executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None

    def _warmup_models(self) -> None:
        """Warmup both models with a sample image to initialize the inference engines."""
        if self._warmup_complete:
            return

        warmup_path = self.get_warmup_image_path()

        # If warmup image doesn't exist, create a synthetic one
        warmup_image: NDArray[np.uint8]
        if not warmup_path.exists():
            self.logger.debug("Warmup image not found, using synthetic image")
            warmup_image = np.random.randint(0, 255, (224, 224, 3), dtype=np.uint8)
        else:
            loaded_image = cv2.imread(str(warmup_path))
            if loaded_image is None:
                self.logger.warning(f"Failed to load warmup image: {warmup_path}")
                warmup_image = np.random.randint(0, 255, (224, 224, 3), dtype=np.uint8)
            else:
                warmup_image = loaded_image.astype(np.uint8)

        with self._suppress_third_party_logs():
            self._classification_probabilities([warmup_image])
            self._run_detection(warmup_image)

        with self._warmup_lock:
            self._warmup_complete = True
            self._cleanup_executor()
        self.logger.debug("Models warmup complete")

    def start_warmup_background(self) -> Future[None]:
        """Start model warmup in a background thread.

        Allows the browser to start and load the challenge page
        while the models are warming up concurrently.

        Returns:
            Future that completes when warmup is done.
        """
        with self._warmup_lock:
            if self._warmup_complete:
                # Already warmed up, return completed future
                future: Future[None] = Future()
                future.set_result(None)
                return future

            if self._warmup_future is not None:
                # Warmup already in progress
                return self._warmup_future

            # Start background warmup
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="warmup")
            self._warmup_future = self._executor.submit(self._warmup_models)
            self.logger.debug("Started background model warmup")
            return self._warmup_future

    def ensure_warmup_complete(self, timeout: float | None = None) -> None:
        """Wait for warmup to complete if running in background.

        This should be called before the first inference to ensure
        the models are ready.

        Args:
            timeout: Maximum time to wait in seconds. None means wait forever.
        """
        if self._warmup_complete:
            return

        with self._warmup_lock:
            if self._warmup_complete:
                return
            future = self._warmup_future

        if future is not None:
            future.result(timeout=timeout)
        else:
            # Warmup not started, run synchronously
            self._warmup_models()

    @property
    def is_warmup_complete(self) -> bool:
        """Check if warmup is complete."""
        return self._warmup_complete

    @classmethod
    def get_warmup_image_path(cls) -> Path:
        """Get the path to the warmup image."""
        return Path(__file__).parent.parent / "assets" / "bus.jpg"

    @classmethod
    def get_model_path(cls) -> Path:
        """Get the path to the bundled classification model.

        If the model doesn't exist locally, it will be downloaded automatically.
        """
        model_path = Path(__file__).parent.parent / "models" / "recaptcha_classification_57k.onnx"

        if not model_path.exists():
            cls._download_model(model_path)

        return model_path

    @classmethod
    def _download_model(cls, target_path: Path) -> None:
        """Download the classification model from the remote URL.

        Args:
            target_path: Path where the model should be saved.

        Raises:
            ModelNotFoundError: If download fails or integrity check fails.
        """
        logger = logging.getLogger(__name__)

        if not cls.MODEL_DOWNLOAD_URL or "YOUR_USERNAME" in cls.MODEL_DOWNLOAD_URL:
            raise ModelNotFoundError(
                f"Classification model not found at: {target_path}\n"
                "The model download URL is not configured. Please either:\n"
                "1. Download the model manually and place it at the path above\n"
                "2. Configure MODEL_DOWNLOAD_URL in yolo_detector.py"
            )

        logger.info(f"Model not found locally. Downloading from {cls.MODEL_DOWNLOAD_URL}...")

        # Ensure parent directory exists
        target_path.parent.mkdir(parents=True, exist_ok=True)

        temp_path = target_path.with_suffix(".tmp")

        try:
            # Download with progress reporting
            def _progress_hook(block_num: int, block_size: int, total_size: int) -> None:
                if total_size > 0:
                    percent = min(100, (block_num * block_size * 100) // total_size)
                    # Log every 100 blocks
                    if block_num % 100 == 0:
                        logger.debug(f"Download progress: {percent}%")

            urllib.request.urlretrieve(
                cls.MODEL_DOWNLOAD_URL,
                temp_path,
                reporthook=_progress_hook,
            )

            # Verify integrity if hash is provided
            if cls.MODEL_SHA256:
                logger.debug("Verifying model integrity...")
                sha256_hash = hashlib.sha256()
                with open(temp_path, "rb") as f:
                    for chunk in iter(lambda: f.read(8192), b""):
                        sha256_hash.update(chunk)

                if sha256_hash.hexdigest().lower() != cls.MODEL_SHA256.lower():
                    temp_path.unlink(missing_ok=True)
                    raise ModelNotFoundError(
                        "Model integrity verification failed. The downloaded file may be corrupted."
                    )
                logger.debug("Model integrity verified successfully")

            # Move temp file to final location
            temp_path.rename(target_path)
            logger.info(f"Model downloaded successfully to {target_path}")

        except urllib.error.URLError as e:
            temp_path.unlink(missing_ok=True)
            raise ModelNotFoundError(
                f"Failed to download model from {cls.MODEL_DOWNLOAD_URL}: {e}"
            ) from e
        except OSError as e:
            temp_path.unlink(missing_ok=True)
            raise ModelNotFoundError(f"Failed to save model to {target_path}: {e}") from e

    @property
    def target_mappings(self) -> dict[str, int]:
        """Get the target keyword to class index mapping."""
        return TARGET_MAPPINGS.copy()

    def get_target_class(self, keyword: str) -> int | None:
        """Get the class index for a target keyword.

        Args:
            keyword: Target keyword from captcha challenge.

        Returns:
            Class index, or None if no match found.
        """
        keyword_lower = keyword.lower()

        # Match against class names
        if self._class_names:
            for idx, name in self._class_names.items():
                name_lower = name.lower()
                if name_lower in keyword_lower or keyword_lower in name_lower:
                    return idx

        # Fallback to TARGET_MAPPINGS for any edge cases
        for key, value in TARGET_MAPPINGS.items():
            if key in keyword_lower:
                self.logger.debug(
                    f"Matched keyword '{keyword}' via TARGET_MAPPINGS to class {value}"
                )
                return value

        self.logger.warning(f"No class match found for keyword: '{keyword}'")
        return None

    def get_coco_target_class(self, keyword: str) -> int | None:
        """Get the COCO class index for a target keyword for detection model.

        Args:
            keyword: Target keyword from captcha challenge.

        Returns:
            COCO class index, or None if no match found.
        """
        keyword_lower = keyword.lower()

        for key, value in COCO_TARGET_MAPPINGS.items():
            if key in keyword_lower:
                self.logger.debug(f"Matched keyword '{keyword}' to COCO class {value}")
                return value

        self.logger.critical(
            f"No COCO class match found for keyword: '{keyword}'. "
            "This target may not be supported for 4x4 detection."
        )
        return None

    def classify_image(self, image: NDArray[np.uint8]) -> tuple[int, float, str]:
        """Classify a single image using the classification model.

        Args:
            image: Image as numpy array (BGR format from cv2).

        Returns:
            Tuple of (class_id, confidence, class_name).
        """
        probabilities = self._classification_probabilities([image])
        if probabilities.size == 0:
            return -1, 0.0, "unknown"
        class_id = int(np.argmax(probabilities[0]))
        confidence = float(probabilities[0, class_id])
        class_name = self._class_names.get(class_id, "unknown")

        return class_id, confidence, class_name

    def get_target_confidence(self, image: NDArray[np.uint8], target_class: int) -> float:
        """Get the confidence for a target class using the classification model.

        Args:
            image: Image as numpy array (BGR format from cv2).
            target_class: The class ID to get confidence for.

        Returns:
            Confidence score for the target class (0.0 to 1.0).
        """
        probabilities = self._classification_probabilities([image])
        if probabilities.size == 0 or target_class >= probabilities.shape[1]:
            return 0.0
        return float(probabilities[0, target_class])

    def get_target_confidences_batch(
        self,
        images: list[NDArray[np.uint8]],
        target_class: int,
    ) -> list[float]:
        """Get target class confidence for multiple images in a single batch prediction.

        Args:
            images: List of images as numpy arrays (BGR format from cv2).
            target_class: The class ID to get confidence for.

        Returns:
            List of confidence scores for the target class (0.0 to 1.0) for each image.
        """
        if not images:
            return []

        probabilities = self._classification_probabilities(images)
        if probabilities.size == 0 or target_class >= probabilities.shape[1]:
            return [0.0] * len(images)
        return [float(value) for value in probabilities[:, target_class]]

    @staticmethod
    def _classification_tensor(images: list[NDArray[np.uint8]]) -> NDArray[np.float32]:
        tensors: list[NDArray[np.float32]] = []
        for image in images:
            if image.size == 0:
                raise DetectionError("Cannot classify an empty image")
            height, width = image.shape[:2]
            scale = 640 / min(height, width)
            resized_width = max(640, round(width * scale))
            resized_height = max(640, round(height * scale))
            resized = cv2.resize(
                image,
                (resized_width, resized_height),
                interpolation=cv2.INTER_LINEAR,
            )
            top = (resized_height - 640) // 2
            left = (resized_width - 640) // 2
            cropped = resized[top : top + 640, left : left + 640]
            rgb = cv2.cvtColor(cropped, cv2.COLOR_BGR2RGB)
            tensor = np.transpose(rgb, (2, 0, 1)).astype(np.float32) / 255.0
            tensors.append(np.ascontiguousarray(tensor))
        return np.stack(tensors).astype(np.float32, copy=False)

    def _classification_probabilities(
        self,
        images: list[NDArray[np.uint8]],
    ) -> NDArray[np.float32]:
        if not images:
            return np.empty((0, len(self._class_names)), dtype=np.float32)
        tensor = self._classification_tensor(images)
        output = self._classification_model.run(None, {self._classification_input: tensor})[0]
        return np.asarray(output, dtype=np.float32)

    def classify_tiles(
        self,
        main_image: NDArray[np.uint8],
        grid_size: int,
        target_class: int,
    ) -> list[int]:
        """Classify each tile in a grid and return cells containing the target.

        Args:
            main_image: The main captcha image.
            grid_size: Number of cells per row (3 for 3x3, 4 for 4x4).
            target_class: The class ID we're looking for.

        Returns:
            List of 1-indexed cell numbers containing the target.
        """
        img_height, img_width = main_image.shape[:2]
        tile_h = img_height // grid_size
        tile_w = img_width // grid_size

        target_name = self._class_names.get(target_class, "unknown")
        answers = []

        for row in range(grid_size):
            for col in range(grid_size):
                # Extract tile
                y1 = row * tile_h
                y2 = (row + 1) * tile_h
                x1 = col * tile_w
                x2 = (col + 1) * tile_w

                tile = np.ascontiguousarray(main_image[y1:y2, x1:x2])

                cell_num = row * grid_size + col + 1

                # Get target class confidence
                target_conf = self.get_target_confidence(tile, target_class)
                is_match = target_conf >= self.conf_threshold

                self.logger.debug(
                    f"Tile {cell_num}: {target_name} conf {target_conf:.2f}"
                    + (" SUCCESS TARGET" if is_match else "")
                )

                if is_match:
                    answers.append(cell_num)

        return answers

    def classify_tiles_with_confidence(
        self,
        main_image: NDArray[np.uint8],
        grid_size: int,
        target_class: int,
    ) -> list[tuple[int, float]]:
        """Classify all tiles and return their target confidences for ranking.

        Args:
            main_image: The main captcha image.
            grid_size: Number of cells per row.
            target_class: The class ID we're looking for.

        Returns:
            List of (cell_num, target_confidence) tuples for all cells.
        """
        img_height, img_width = main_image.shape[:2]
        tile_h = img_height // grid_size
        tile_w = img_width // grid_size

        target_name = self._class_names.get(target_class, "unknown")

        # Extract all tiles first
        tiles: list[NDArray[np.uint8]] = []
        cell_nums: list[int] = []

        for row in range(grid_size):
            for col in range(grid_size):
                y1 = row * tile_h
                y2 = (row + 1) * tile_h
                x1 = col * tile_w
                x2 = (col + 1) * tile_w

                tile = np.ascontiguousarray(main_image[y1:y2, x1:x2])
                tiles.append(tile)
                cell_nums.append(row * grid_size + col + 1)

        confidences = self.get_target_confidences_batch(tiles, target_class)

        results: list[tuple[int, float]] = []
        for cell_num, target_conf in zip(cell_nums, confidences, strict=True):
            results.append((cell_num, target_conf))
            self.logger.debug(f"Tile {cell_num}: {target_name} conf {target_conf:.2f}")

        return results

    def detect_objects(
        self,
        image: NDArray[np.uint8],
        target_class: int,
        conf_threshold: float | None = None,
    ) -> list[tuple[int, int, int, int]]:
        """Detect objects in the full image using the detection model.

        Args:
            image: Image as numpy array (BGR format).
            target_class: COCO class index to filter for.
            conf_threshold: Confidence threshold. If None, uses detection_conf_threshold.

        Returns:
            List of bounding boxes as (x1, y1, x2, y2) tuples for detected targets.
        """
        threshold = conf_threshold or self.detection_conf_threshold
        predictions, ratio, pad_left, pad_top = self._run_detection(image)
        if predictions.size == 0 or target_class + 4 >= predictions.shape[1]:
            return []

        class_scores = predictions[:, target_class + 4]
        selected = predictions[class_scores >= threshold]
        selected_scores = class_scores[class_scores >= threshold]
        if selected.size == 0:
            return []

        height, width = image.shape[:2]
        boxes_xywh: list[list[float]] = []
        boxes_xyxy: list[tuple[int, int, int, int]] = []
        valid_scores: list[float] = []
        for prediction, score in zip(selected, selected_scores, strict=True):
            center_x, center_y, box_width, box_height = prediction[:4]
            x1 = max(0.0, (float(center_x - box_width / 2) - pad_left) / ratio)
            y1 = max(0.0, (float(center_y - box_height / 2) - pad_top) / ratio)
            x2 = min(float(width), (float(center_x + box_width / 2) - pad_left) / ratio)
            y2 = min(float(height), (float(center_y + box_height / 2) - pad_top) / ratio)
            if x2 <= x1 or y2 <= y1:
                continue
            boxes_xywh.append([x1, y1, x2 - x1, y2 - y1])
            boxes_xyxy.append((int(x1), int(y1), int(x2), int(y2)))
            valid_scores.append(float(score))

        if not boxes_xywh:
            return []
        kept_indices = cv2.dnn.NMSBoxes(
            boxes_xywh,
            valid_scores,
            score_threshold=threshold,
            nms_threshold=0.45,
        )
        result = [boxes_xyxy[int(index)] for index in np.asarray(kept_indices).reshape(-1)]
        for x1, y1, x2, y2 in result:
            self.logger.debug(f"Detected target at [{x1}, {y1}, {x2}, {y2}]")
        return result

    def _run_detection(
        self,
        image: NDArray[np.uint8],
    ) -> tuple[NDArray[np.float32], float, int, int]:
        if image.size == 0:
            raise DetectionError("Cannot detect objects in an empty image")
        height, width = image.shape[:2]
        ratio = min(640 / height, 640 / width)
        resized_width = max(1, round(width * ratio))
        resized_height = max(1, round(height * ratio))
        resized = cv2.resize(
            image,
            (resized_width, resized_height),
            interpolation=cv2.INTER_LINEAR,
        )
        pad_left = round((640 - resized_width) / 2 - 0.1)
        pad_top = round((640 - resized_height) / 2 - 0.1)
        padded: NDArray[np.uint8] = np.full((640, 640, 3), 114, dtype=np.uint8)
        padded[
            pad_top : pad_top + resized_height,
            pad_left : pad_left + resized_width,
        ] = resized
        rgb = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB)
        tensor = np.transpose(rgb, (2, 0, 1)).astype(np.float32) / 255.0
        batch = np.expand_dims(np.ascontiguousarray(tensor), axis=0)
        output = self._detection_model.run(None, {self._detection_input: batch})[0]
        predictions = np.asarray(output, dtype=np.float32)
        if predictions.ndim != 3 or predictions.shape[0] != 1:
            raise DetectionError(f"Unexpected detection ONNX output shape: {predictions.shape}")
        return predictions[0].T, ratio, pad_left, pad_top

    def detect_for_grid(
        self,
        image: NDArray[np.uint8],
        target_class: int,
        grid_size: int = 450,
        conf_threshold: float | None = None,
    ) -> list[int]:
        """Detect objects and map them to grid cells.

        Uses the detection model to find all instances of the target class,
        then determines which grid cells contain each detection.

        Args:
            image: The captcha image.
            target_class: COCO class index to detect.
            grid_size: Total size of the grid in pixels (default 450 for 4x4).
            conf_threshold: Confidence threshold for detections.

        Returns:
            List of 1-indexed cell numbers containing targets.
        """
        bboxes = self.detect_objects(image, target_class, conf_threshold)

        if not bboxes:
            self.logger.debug("No objects detected in image")
            return []

        all_cells: set[int] = set()

        for bbox in bboxes:
            cells = calculate_4x4_cells(bbox, grid_size)
            all_cells.update(cells)

        result = sorted(all_cells)
        self.logger.debug(f"Total cells with targets: {result}")
        return result

    def detect(
        self,
        image: NDArray[np.uint8],
        target_class: int,
        captcha_type: CaptchaType = CaptchaType.SELECTION_3X3,
    ) -> DetectionResult:
        """Detect target objects by classifying each tile.

        Args:
            image: The main captcha image.
            target_class: Class index of the target object.
            captcha_type: Type of captcha grid.

        Returns:
            DetectionResult with cell answers.
        """
        try:
            target_name = self._class_names.get(target_class, "unknown")
            self.logger.debug(f"Searching for target class {target_class}: '{target_name}'")

            # Determine grid size
            grid_size = 4 if captcha_type == CaptchaType.SQUARE_4X4 else 3

            # Classify each tile
            answers = self.classify_tiles(image, grid_size, target_class)

            if not answers:
                self.logger.debug("No targets detected in any tile")
                return DetectionResult(answers=[], confidence=0.0, target_class=target_class)

            self.logger.debug(f"Target found in cells: {answers}")

            return DetectionResult(
                answers=answers,
                confidence=1.0,
                target_class=target_class,
            )

        except (ValueError, RuntimeError, IndexError) as e:
            raise DetectionError(f"Detection failed: {e}") from e
