"""Backoff and retry behavior."""

from __future__ import annotations

import httpx
import pytest

from budgetary import (
    BudgetaryRateLimitError,
    BudgetaryServerError,
    BudgetaryValidationError,
)
from budgetary._internal.retry import with_retry


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
