"""Backoff and retry behavior."""

from __future__ import annotations

import httpx
import pytest

from budgetary import (
    BudgetaryRateLimitError,
    BudgetaryServerError,
    BudgetaryValidationError,
)
from budgetary._internal.http import _parse_retry_after
from budgetary._internal.retry import with_retry


def test_parse_retry_after_rejects_non_finite_values():
    # `float("nan")` / `float("inf")` parse without raising; a non-finite floor
    # would pierce the min/max clamp in with_retry and reach time.sleep(nan) →
    # a raw ValueError. Only a finite number is a valid delay. (P-C4)
    assert _parse_retry_after("nan") is None
    assert _parse_retry_after("inf") is None
    assert _parse_retry_after("-inf") is None
    # A finite numeric header still parses.
    assert _parse_retry_after("2") == 2.0
    # A non-numeric header falls through to the (failed) HTTP-date path → None.
    assert _parse_retry_after("garbage") is None


def _server_error() -> BudgetaryServerError:
    return BudgetaryServerError(
        code="internal_error",
        message="boom",
        http_status=500,
        request_id=None,
    )


def _rate_limit_error(retry_after: float | None) -> BudgetaryRateLimitError:
    return BudgetaryRateLimitError(
        code="rate_limited",
        message="slow down",
        http_status=429,
        request_id=None,
        retry_after_seconds=retry_after,
    )


def test_exponential_backoff_delays(monkeypatch):
    sleeps: list[float] = []
    attempts = {"n": 0}

    def fn() -> str:
        attempts["n"] += 1
        if attempts["n"] < 4:
            raise _server_error()
        return "ok"

    result = with_retry(
        fn,
        max_retries=5,
        sleep=lambda s: sleeps.append(s),
        random_fn=lambda: 1.0,  # disable jitter
    )

    assert result == "ok"
    assert attempts["n"] == 4
    # 4 attempts → 3 sleeps with delays 1.0, 2.0, 4.0 seconds.
    assert sleeps == [1.0, 2.0, 4.0]


def test_retry_after_floor():
    sleeps: list[float] = []
    attempts = {"n": 0}

    def fn() -> str:
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise _rate_limit_error(retry_after=2.0)
        return "ok"

    with_retry(
        fn,
        max_retries=3,
        sleep=lambda s: sleeps.append(s),
        random_fn=lambda: 0.01,  # would compute tiny jitter; Retry-After dominates
    )

    assert len(sleeps) == 1
    assert sleeps[0] >= 2.0


def test_retry_after_jitter_desyncs_a_correlated_fleet():
    # Two clients see the SAME Retry-After: 1 at a fixed-window boundary. The
    # floor still holds, but jitter is ADDED on top so their backoffs DIFFER
    # (de-synced) rather than collapsing into one bucket. Parity with the TS SDK.
    def backoff_for(rand: float) -> float:
        sleeps: list[float] = []
        n = {"v": 0}

        def fn() -> str:
            n["v"] += 1
            if n["v"] == 1:
                raise _rate_limit_error(retry_after=1.0)
            return "ok"

        with_retry(
            fn,
            max_retries=2,
            sleep=lambda s: sleeps.append(s),
            random_fn=lambda: rand,
        )
        return sleeps[0]

    # computed at attempt 0 = 1.0 s, floor = 1.0 s.
    a = backoff_for(0.2)  # 1.0 + 0.2*1.0
    b = backoff_for(0.8)  # 1.0 + 0.8*1.0
    assert a >= 1.0  # never earlier than the server asked
    assert b >= 1.0
    assert a == pytest.approx(1.2)
    assert b == pytest.approx(1.8)
    assert a != b  # de-synced


def test_retry_after_is_clamped_to_max_delay():
    sleeps: list[float] = []
    attempts = {"n": 0}

    def fn() -> str:
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise _rate_limit_error(retry_after=9999.0)  # 9,999,000 ms
        return "ok"

    with_retry(
        fn,
        max_retries=3,
        max_delay_ms=60_000,
        sleep=lambda s: sleeps.append(s),
        random_fn=lambda: 1.0,
    )

    assert len(sleeps) == 1
    # Retry-After (9,999,000 ms) is clamped to max_delay_ms (60 s), so a huge or
    # hostile header can't stall the client for minutes (parity with the TS SDK).
    assert sleeps[0] == 60.0


def test_non_retryable_error_does_not_retry():
    attempts = {"n": 0}

    def fn() -> str:
        attempts["n"] += 1
        raise BudgetaryValidationError(
            code="invalid_request",
            message="nope",
            http_status=400,
            request_id=None,
        )

    with pytest.raises(BudgetaryValidationError):
        with_retry(fn, max_retries=5, sleep=lambda _s: None, random_fn=lambda: 0.0)

    assert attempts["n"] == 1


def test_max_retries_caps_total_attempts_at_n_plus_one():
    attempts = {"n": 0}

    def fn() -> str:
        attempts["n"] += 1
        raise _server_error()

    with pytest.raises(BudgetaryServerError):
        with_retry(fn, max_retries=2, sleep=lambda _s: None, random_fn=lambda: 0.0)

    assert attempts["n"] == 3


def test_client_does_not_retry_400(respx_mock, make_client):
    calls = {"n": 0}

    def handler(_request):
        calls["n"] += 1
        return httpx.Response(
            400,
            json={
                "error": {
                    "code": "invalid_request",
                    "message": "x",
                    "request_id": "r",
                }
            },
        )

    respx_mock.post("/v1/estimate").mock(side_effect=handler)
    client = make_client(max_retries=5)

    with pytest.raises(BudgetaryValidationError):
        client.estimate("hi", client_request_id=None)

    assert calls["n"] == 1


def test_client_retries_503_and_eventually_succeeds(respx_mock, make_client):
    calls = {"n": 0}

    def handler(_request):
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(
                503,
                json={
                    "error": {
                        "code": "unavailable",
                        "message": "x",
                        "request_id": "r",
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "estimate_id": "est_ok",
                "scenario": "confident",
                "void": False,
                "distribution": {
                    "p10": 1,
                    "p50": 2,
                    "p90": 3,
                    "unit": "tokens",
                },
                "confidence": 0.9,
                "model": "claude-opus-4-7",
                "expires_at": "2026-05-27T10:14:00Z",
            },
        )

    respx_mock.post("/v1/estimate").mock(side_effect=handler)
    # Swap real sleep to a no-op via monkeypatching the retry module.
    import budgetary._internal.retry as retry_module

    original_sleep = retry_module._time_module.sleep
    retry_module._time_module.sleep = lambda _s: None
    try:
        c = make_client(max_retries=5)
        res = c.estimate("hi", client_request_id=None)
    finally:
        retry_module._time_module.sleep = original_sleep

    assert res.estimate_id == "est_ok"
    assert calls["n"] == 3


# --- O-6: attempts / total_elapsed_ms / on_retry (parity with the TS SDK) ---


def test_annotates_attempts_and_elapsed_on_exhaustion():
    clock = {"t": 0.0}

    def sleep(s: float) -> None:
        clock["t"] += s  # a fake clock: sleeping advances monotonic time

    def monotonic() -> float:
        return clock["t"]

    def fn() -> str:
        raise _server_error()

    with pytest.raises(BudgetaryServerError) as ei:
        with_retry(
            fn,
            max_retries=2,
            sleep=sleep,
            monotonic=monotonic,
            random_fn=lambda: 1.0,
        )

    err = ei.value
    # 3 total attempts (initial + 2 retries).
    assert err.attempts == 3
    # 2 sleeps of 1.0 s + 2.0 s = 3.0 s = 3000 ms.
    assert err.total_elapsed_ms == pytest.approx(3000.0)


def test_annotates_non_retryable_with_attempts_1():
    def fn() -> str:
        raise BudgetaryValidationError(
            code="invalid_request", message="nope", http_status=400, request_id=None
        )

    with pytest.raises(BudgetaryValidationError) as ei:
        with_retry(fn, max_retries=5, sleep=lambda _s: None, random_fn=lambda: 0.0)

    assert ei.value.attempts == 1
    assert ei.value.total_elapsed_ms is not None


def test_on_retry_invoked_with_attempt_delay_status():
    seen: list[tuple[int, float, int | None]] = []
    calls = {"n": 0}

    def fn() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise BudgetaryServerError(
                code="unavailable", message="x", http_status=503, request_id=None
            )
        return "ok"

    with_retry(
        fn,
        max_retries=5,
        sleep=lambda _s: None,
        random_fn=lambda: 1.0,
        on_retry=lambda attempt, delay_ms, status: seen.append(
            (attempt, delay_ms, status)
        ),
    )

    assert seen == [(1, 1000.0, 503), (2, 2000.0, 503)]


def test_on_retry_throw_is_swallowed():
    calls = {"n": 0}

    def fn() -> str:
        calls["n"] += 1
        if calls["n"] < 2:
            raise _server_error()
        return "ok"

    def boom(_attempt: int, _delay: float, _status: int | None) -> None:
        raise RuntimeError("observer blew up")

    # A diagnostic hook must never derail the request.
    res = with_retry(
        fn, max_retries=3, sleep=lambda _s: None, random_fn=lambda: 0.0, on_retry=boom
    )
    assert res == "ok"


def test_non_budgetary_exception_propagates_unannotated():
    # The broadened `except BudgetaryError` must NOT catch a non-Budgetary
    # exception — it propagates unchanged (no annotation, no retry). This guards
    # the single riskiest behavior change (invariant #2).
    def fn() -> str:
        raise ValueError("not a budgetary error")

    with pytest.raises(ValueError):
        with_retry(fn, max_retries=5, sleep=lambda _s: None, random_fn=lambda: 0.0)


def test_on_retry_reports_429_status():
    seen: list[int | None] = []

    def fn() -> str:
        raise _rate_limit_error(retry_after=None)  # will exhaust

    with pytest.raises(BudgetaryRateLimitError):
        with_retry(
            fn,
            max_retries=1,
            sleep=lambda _s: None,
            random_fn=lambda: 1.0,
            on_retry=lambda _a, _d, status: seen.append(status),
        )

    assert seen == [429]  # the failing status is reported to the observer


def test_client_annotates_returned_error_with_attempts(respx_mock, make_client):
    # Parity with the TS SDK's errors.test.ts: the annotation reaches a caller
    # through a real client request, not only the with_retry unit.
    def handler(_request):
        return httpx.Response(
            500,
            json={"error": {"code": "internal_error", "message": "boom", "request_id": "r"}},
        )

    respx_mock.post("/v1/estimate").mock(side_effect=handler)
    client = make_client(max_retries=0)  # exactly one attempt

    with pytest.raises(BudgetaryServerError) as ei:
        client.estimate("hi", client_request_id=None)

    assert ei.value.attempts == 1
    assert ei.value.total_elapsed_ms is not None
