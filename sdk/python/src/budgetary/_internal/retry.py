"""Exponential backoff with full jitter; a 429 ``Retry-After`` is used as a
floor with jitter added ON TOP (so a correlated fleet de-syncs instead of
re-synchronizing) and clamped to ``max_delay_ms`` — parity with the TypeScript
SDK."""

from __future__ import annotations

import random as _random_module
import time as _time_module
from collections.abc import Callable
from typing import Optional, TypeVar

from budgetary.errors import (
    BudgetaryError,
    BudgetaryRateLimitError,
    BudgetaryServerError,
)

T = TypeVar("T")

DEFAULT_INITIAL_DELAY_MS = 1000
DEFAULT_FACTOR = 2
DEFAULT_MAX_DELAY_MS = 60_000

# Observer invoked before each backoff sleep: (attempt, delay_ms, http_status).
# ``attempt`` is 1-based (the attempt that just failed); ``http_status`` is None
# for a transport failure. Purely diagnostic — a raise from it is swallowed.
OnRetry = Callable[[int, float, Optional[int]], None]


def with_retry(
    fn: Callable[[], T],
    *,
    max_retries: int,
    initial_delay_ms: int = DEFAULT_INITIAL_DELAY_MS,
    factor: float = DEFAULT_FACTOR,
    max_delay_ms: int = DEFAULT_MAX_DELAY_MS,
    sleep: Callable[[float], None] = _time_module.sleep,
    random_fn: Callable[[], float] = _random_module.random,
    monotonic: Callable[[], float] = _time_module.monotonic,
    on_retry: OnRetry | None = None,
) -> T:
    """Run ``fn`` with retries on ``BudgetaryServerError`` and ``BudgetaryRateLimitError``.

    Total attempts = ``max_retries + 1``. Non-retryable errors propagate
    immediately. ``Retry-After`` (when set on a 429) is used as a floor.

    On the FINAL throw (a non-retryable error, or exhaustion) the caught
    ``BudgetaryError`` is annotated with ``attempts`` (1-based) and
    ``total_elapsed_ms`` — so a ~4-minute 429 backoff no longer reads as a
    first-attempt blip. Additive: the error type and propagation timing are
    unchanged (a non-retryable error is still re-raised immediately, no sleep).
    Parity with the TS SDK.
    """
    max_retries = max(0, max_retries)
    started = monotonic()
    attempt = 0
    while True:
        try:
            return fn()
        except BudgetaryError as err:
            # ``attempt`` is 0-based (retries taken); this attempt just failed, so
            # the number of attempts MADE is attempt + 1.
            attempts_made = attempt + 1
            retryable = isinstance(
                err, (BudgetaryServerError, BudgetaryRateLimitError)
            )
            if not retryable or attempt >= max_retries:
                err.attempts = attempts_made
                err.total_elapsed_ms = (monotonic() - started) * 1000.0
                raise
            # Retry-After budget guard: if the server's stated wait EXCEEDS the
            # most we would ever sleep in one backoff (``max_delay_ms``), then
            # sleeping the clamped ``max_delay_ms`` and retrying would fire BEFORE
            # the server said success is possible — a guaranteed second 429 that
            # wastes an attempt and hammers a strained engine. Fail fast instead,
            # propagating the rate-limit error with ``retry_after_seconds`` intact
            # so the caller honors the FULL wait. Parity with the TS SDK.
            if (
                isinstance(err, BudgetaryRateLimitError)
                and err.retry_after_seconds is not None
                and err.retry_after_seconds * 1000.0 > max_delay_ms
            ):
                err.attempts = attempts_made
                err.total_elapsed_ms = (monotonic() - started) * 1000.0
                raise
            computed_ms = min(initial_delay_ms * (factor**attempt), max_delay_ms)
            jitter_ms = random_fn() * computed_ms
            delay_ms = jitter_ms
            if (
                isinstance(err, BudgetaryRateLimitError)
                and err.retry_after_seconds is not None
            ):
                # Retry-After is a FLOOR, then jitter is ADDED on top (never a
                # deterministic max(retry_after, computed)) so a correlated fleet
                # all seeing the same Retry-After at a fixed-window boundary
                # de-syncs across [retry_after, retry_after+computed) instead of
                # re-synchronizing into one bucket and thundering-herd'ing the
                # engine. Here retry_after*1000 <= max_delay_ms (a longer wait
                # already failed fast above), so the clamp only trims the jitter
                # tail — the floor is always honored. Parity with the TS SDK.
                delay_ms = min(
                    err.retry_after_seconds * 1000.0 + jitter_ms,
                    max_delay_ms,
                )
            if on_retry is not None:
                # A diagnostic hook must never derail the request.
                try:
                    on_retry(attempts_made, delay_ms, err.http_status)
                except Exception:  # noqa: BLE001 — observer faults are ignored
                    pass
            sleep(delay_ms / 1000.0)
            attempt += 1
