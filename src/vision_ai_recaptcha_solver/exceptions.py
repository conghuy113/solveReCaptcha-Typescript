"""Custom exceptions."""

from __future__ import annotations


class RecaptchaSolverError(Exception):
    """Base exception for all errors."""

    def __init__(self, message: str, *args: object) -> None:
        self.message = message
        super().__init__(message, *args)


class BrowserError(RecaptchaSolverError):
    """Raised when browser initialization or navigation fails."""

    pass


class CaptchaNotFoundError(RecaptchaSolverError):
    """Raised when the captcha iframe cannot be detected on the page."""

    pass


class UnsupportedCaptchaError(RecaptchaSolverError):
    """Raised when an unknown or unsupported captcha type is encountered."""

    pass


class DetectionError(RecaptchaSolverError):
    """Raised when YOLO model inference fails."""

    pass


class TokenExtractionError(RecaptchaSolverError):
    """Raised when the reCAPTCHA token cannot be extracted after solving."""

    pass


class SolverTimeoutError(RecaptchaSolverError):
    """Raised when a captcha solving operation times out."""

    pass


CaptchaTimeoutError = SolverTimeoutError


class ModelNotFoundError(RecaptchaSolverError):
    """Raised when the ONNX model file cannot be found."""

    pass


class ImageDownloadError(RecaptchaSolverError):
    """Raised when image download fails after all retries."""

    pass


class LowConfidenceError(RecaptchaSolverError):
    """Raised when detection confidence is too low to proceed safely."""

    pass


class ElementNotFoundError(RecaptchaSolverError):
    """Raised when a required page element cannot be found."""

    pass


class NavigationError(RecaptchaSolverError):
    """Raised when browser navigation fails."""

    pass
