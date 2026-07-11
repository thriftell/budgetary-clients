"""HTTP status → exception class mapping."""

from __future__ import annotations

import httpx
import pytest

from budgetary import (
    BudgetaryAuthError,
    BudgetaryError,
    BudgetaryNotFoundError,
    BudgetaryPermissionError,
    BudgetaryRateLimitError,
    BudgetaryServerError,
    BudgetaryValidationError,
)


def _error_body(code: str, message: str = "x", request_id: str = "req_test") -> dict:
    return {"error": {"code": code, "message": message, "request_id": request_id}}


CASES: list[tuple[int, str, type[BudgetaryError]]] = [
    (400, "invalid_request", BudgetaryValidationError),
    (401, "authentication_failed", BudgetaryAuthError),
    (403, "permission_denied", BudgetaryPermissionError),
    (404, "not_found", BudgetaryNotFoundError),
    (409, "idempotency_conflict", BudgetaryValidationError),
    (413, "payload_too_large", BudgetaryValidationError),
    (500, "internal_error", BudgetaryServerError),
    (503, "unavailable", BudgetaryServerError),
]


@pytest.mark.parametrize("status,code,exc_cls", CASES)
def test_status_to_exception_mapping(respx_mock, client, status, code, exc_cls):
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(status, json=_error_body(code))
    )

    with pytest.raises(exc_cls) as excinfo:
        client.estimate("hi", client_request_id=None)

    err = excinfo.value
    assert err.code == code
    assert err.http_status == status
    assert err.request_id == "req_test"


def test_403_permission_error_is_distinct_from_auth_error(respx_mock, client):
    # 403 raises BudgetaryPermissionError, a SIBLING of BudgetaryAuthError (both
    # extend BudgetaryError) — matching the TS SDK. A handler catching
    # BudgetaryAuthError must NOT also swallow a 403; the two are distinguishable.
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(403, json=_error_body("permission_denied"))
    )

    with pytest.raises(BudgetaryPermissionError) as excinfo:
        client.estimate("hi", client_request_id=None)

    err = excinfo.value
    assert not isinstance(err, BudgetaryAuthError)
    assert isinstance(err, BudgetaryError)
    assert err.code == "permission_denied"
    assert err.http_status == 403


def test_429_populates_retry_after_seconds(respx_mock, client):
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(
            429,
            headers={"Retry-After": "7"},
            json=_error_body("rate_limited", message="too many"),
        )
    )

    with pytest.raises(BudgetaryRateLimitError) as excinfo:
        client.estimate("hi", client_request_id=None)

    err = excinfo.value
    assert err.code == "rate_limited"
    assert err.http_status == 429
    assert err.retry_after_seconds == 7.0


def test_429_populates_ratelimit_window_headers(respx_mock, client):
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(
            429,
            headers={
                "Retry-After": "7",
                "X-RateLimit-Limit": "100",
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": "1717000000",
            },
            json=_error_body("rate_limited", message="too many"),
        )
    )

    with pytest.raises(BudgetaryRateLimitError) as excinfo:
        client.estimate("hi", client_request_id=None)

    err = excinfo.value
    assert err.limit == 100
    assert err.remaining == 0
    assert err.reset_seconds == 1717000000


def test_429_non_integer_ratelimit_header_degrades_to_none(respx_mock, client):
    # A contract-violating float/hex/scientific header must NOT surface a bogus
    # number, and must match the TS SDK (both -> None) so the two never diverge.
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(
            429,
            headers={
                "X-RateLimit-Limit": "1.5",
                "X-RateLimit-Remaining": "0x10",
                "X-RateLimit-Reset": "1e3",
            },
            json=_error_body("rate_limited", message="too many"),
        )
    )

    with pytest.raises(BudgetaryRateLimitError) as excinfo:
        client.estimate("hi", client_request_id=None)

    err = excinfo.value
    assert err.limit is None
    assert err.remaining is None
    assert err.reset_seconds is None


def test_429_without_ratelimit_headers_leaves_window_fields_none(respx_mock, client):
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(
            429, json=_error_body("rate_limited", message="too many")
        )
    )

    with pytest.raises(BudgetaryRateLimitError) as excinfo:
        client.estimate("hi", client_request_id=None)

    err = excinfo.value
    assert err.limit is None
    assert err.remaining is None
    assert err.reset_seconds is None
