"""Typed exception hierarchy mirroring the v1 contract's error codes."""

from __future__ import annotations


class BudgetaryError(Exception):
    """Base class for all Budgetary SDK errors."""

    def __init__(
        self,
        *,
        code: str,
        message: str,
        http_status: int | None,
        request_id: str | None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.request_id = request_id


class BudgetaryAuthError(BudgetaryError):
    """401 ``authentication_failed`` or 403 ``permission_denied``."""


class BudgetaryNotFoundError(BudgetaryError):
    """404 ``not_found``."""


class BudgetaryValidationError(BudgetaryError):
    """400 ``invalid_request``, 409 ``idempotency_conflict``, 413 ``payload_too_large``."""


class BudgetaryServerError(BudgetaryError):
    """5xx ``internal_error`` or ``unavailable``."""


class BudgetaryRateLimitError(BudgetaryError):
    """429 ``rate_limited``. Exposes the server's ``Retry-After`` when present."""

    def __init__(
        self,
        *,
        code: str,
        message: str,
        http_status: int | None,
        request_id: str | None,
        retry_after_seconds: float | None,
    ) -> None:
        super().__init__(
            code=code,
            message=message,
            http_status=http_status,
            request_id=request_id,
        )
        self.retry_after_seconds = retry_after_seconds


class BudgetaryNetworkError(BudgetaryError):
    """Transport-level failure with no HTTP response: timeout, connection error, abort."""

    def __init__(self, *, code: str, message: str) -> None:
        super().__init__(
            code=code,
            message=message,
            http_status=None,
            request_id=None,
        )
