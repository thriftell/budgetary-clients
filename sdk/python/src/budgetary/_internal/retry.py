"""Exponential backoff with full jitter; a 429 ``Retry-After`` is used as a
floor and clamped to ``max_delay_ms`` — parity with the TypeScript SDK."""

from __future__ import annotations

import random as _random_module
import time as _time_module
from collections.abc import Callable
from typing import TypeVar

from budgetary.errors import BudgetaryRateLimitError, BudgetaryServerError

T = TypeVar("T")

DEFAULT_INITIAL_DELAY_MS = 1000
DEFAULT_FACTOR = 2
DEFAULT_MAX_DELAY_MS = 60_000


def with_retry(
    fn: Callable[[], T],
    *,
    max_retries: int,
    initial_delay_ms: int = DEFAULT_INITIAL_DELAY_MS,
    factor: float = DEFAULT_FACTOR,
    max_delay_ms: int = DEFAULT_MAX_DELAY_MS,
    sleep: Callable[[float], None] = _time_module.sleep,
    random_fn: Callable[[], float] = _random_module.random,
) -> T:
    """Run ``fn`` with retries on ``BudgetaryServerError`` and ``BudgetaryRateLimitError``.

    Total attempts = ``max_retries + 1``. Non-retryable errors propagate
    immediately. ``Retry-After`` (when set on a 429) is used as a floor.
    """
    max_retries = max(0, max_retries)
    attempt = 0
    while True:
        try:
            return fn()
        except (BudgetaryServerError, BudgetaryRateLimitError) as err:
            if attempt >= max_retries:
                raise
            computed_ms = min(initial_delay_ms * (factor**attempt), max_delay_ms)
            delay_ms = random_fn() * computed_ms
            if (
                isinstance(err, BudgetaryRateLimitError)
                and err.retry_after_seconds is not None
            ):
                # Retry-After is a floor, but still clamped to max_delay_ms so a
                # large (or hostile) header can't stall the client for minutes.
                delay_ms = min(
                    max(err.retry_after_seconds * 1000.0, computed_ms),
                    max_delay_ms,
                )
            sleep(delay_ms / 1000.0)
            attempt += 1
