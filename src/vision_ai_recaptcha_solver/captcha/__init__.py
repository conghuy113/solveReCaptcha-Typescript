"""Captcha handling module."""

from vision_ai_recaptcha_solver.captcha.base_handler import BaseCaptchaHandler
from vision_ai_recaptcha_solver.captcha.dynamic_handler import DynamicCaptchaHandler
from vision_ai_recaptcha_solver.captcha.image_utils import (
    composite_image,
    download_image,
    load_image_as_array,
    save_image,
)
from vision_ai_recaptcha_solver.captcha.selection_handler import SelectionCaptchaHandler
from vision_ai_recaptcha_solver.captcha.square_handler import SquareCaptchaHandler

__all__ = [
    "BaseCaptchaHandler",
    "DynamicCaptchaHandler",
    "SelectionCaptchaHandler",
    "SquareCaptchaHandler",
    "download_image",
    "load_image_as_array",
    "composite_image",
    "save_image",
]
