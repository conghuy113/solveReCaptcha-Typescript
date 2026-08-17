"""
VisionAIRecaptchaSolver - AI powered reCAPTCHA solver using YOLO object detection.

This library provides both synchronous and asynchronous interfaces for solving
reCAPTCHA challenges using YOLO-based image detection.
"""

import importlib
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from vision_ai_recaptcha_solver.config import SolverConfig
from vision_ai_recaptcha_solver.exceptions import (
    BrowserError,
    CaptchaNotFoundError,
    CaptchaTimeoutError,
    DetectionError,
    ElementNotFoundError,
    ImageDownloadError,
    LowConfidenceError,
    ModelNotFoundError,
    NavigationError,
    RecaptchaSolverError,
    SolverTimeoutError,
    TokenExtractionError,
    UnsupportedCaptchaError,
)
from vision_ai_recaptcha_solver.types import (
    CLASS_NAMES,
    COCO_TARGET_MAPPINGS,
    TARGET_MAPPINGS,
    CaptchaType,
    DetectionResult,
    SolveResult,
)

try:
    __version__ = version("vision-ai-recaptcha-solver")
except PackageNotFoundError:
    __version__ = "1.0.0"


def __getattr__(name: str) -> Any:
    """Load model-heavy solver modules only when their public classes are used."""
    if name == "RecaptchaSolver":
        solver_class = importlib.import_module("vision_ai_recaptcha_solver.solver").RecaptchaSolver
        globals()[name] = solver_class
        return solver_class
    if name == "AsyncRecaptchaSolver":
        solver_class = importlib.import_module(
            "vision_ai_recaptcha_solver.async_solver"
        ).AsyncRecaptchaSolver
        globals()[name] = solver_class
        return solver_class
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "RecaptchaSolver",
    "AsyncRecaptchaSolver",
    "SolverConfig",
    "SolveResult",
    "DetectionResult",
    "CaptchaType",
    "CLASS_NAMES",
    "TARGET_MAPPINGS",
    "COCO_TARGET_MAPPINGS",
    "RecaptchaSolverError",
    "BrowserError",
    "CaptchaNotFoundError",
    "UnsupportedCaptchaError",
    "DetectionError",
    "TokenExtractionError",
    "SolverTimeoutError",
    "CaptchaTimeoutError",
    "ModelNotFoundError",
    "ImageDownloadError",
    "LowConfidenceError",
    "ElementNotFoundError",
    "NavigationError",
    "__version__",
]
