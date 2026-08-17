"""Utility functions."""

from __future__ import annotations

import time

import numpy as np


def human_delay(
    mean: float = 0.3,
    sigma: float = 0.1,
    min_delay: float = 0.1,
) -> None:
    """Add a random human like delay.

    Uses a normal distribution to create realistic, variable delays
    that mimic human interaction timing.

    Args:
        mean: Mean delay in seconds.
        sigma: Standard deviation for the delay.
        min_delay: Minimum delay.
    """
    delay = max(min_delay, np.random.normal(mean, sigma))
    time.sleep(delay)
