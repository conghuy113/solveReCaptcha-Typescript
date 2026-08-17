"""Logging configuration."""

from __future__ import annotations

import logging
import sys
from typing import TextIO


def setup_logging(
    level: str = "INFO",
    name: str = "vision_ai_recaptcha_solver",
    stream: TextIO = sys.stderr,
) -> logging.Logger:
    """Configure and return a logger.

    Args:
        level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL).
        name: Logger name.
        stream: Output stream for log messages.

    Returns:
        Configured Logger instance.
    """
    logger = logging.getLogger(name)

    # Avoid adding duplicate handlers
    if logger.handlers:
        return logger

    logger.setLevel(getattr(logging, level.upper(), logging.INFO))

    handler = logging.StreamHandler(stream)
    handler.setLevel(logger.level)

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler.setFormatter(formatter)

    logger.addHandler(handler)
    logger.propagate = False

    return logger
