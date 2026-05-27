"""Single chokepoint for HTTP. Handles auth, error mapping, and retry orchestration."""

from __future__ import annotations

from email.utils import parsedate_to_datetime
from typing import Any, Callable, TypeVar

import httpx

from budgetary.errors import (
    BudgetaryAuthError,
    BudgetaryError,
    BudgetaryNetworkError,
    BudgetaryNotFoundError,
    BudgetaryRateLimitError,
    BudgetaryServerError,
    BudgetaryValidationError,
)

from .retry import with_retry

T = TypeVar("T")


def _default_code_for_status(status: int) -> str:
    return {
        400: "invalid_request",
        401: "authentication_failed",
        403: "permission_denied",
        404: "not_found",
        409: "idempotency_conflict",
        413: "payload_too_large",
        429: "rate_limited",
        503: "unavailable",
    }.get(status, "internal_error" if status >= 500 else f"http_{status}")


def _parse_retry_after(header: str | None) -> float | None:
    if header is None:
        return None
    try:
        return float(header)
    except (TypeError, ValueError):
        pass
    try:
        target = parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    if target is None:
        return None
    import time

    seconds = target.timestamp() - time.time()
    return max(0.0, seconds)


def _build_error(
    status: int, body: dict[str, Any] | None, headers: httpx.Headers
) -> BudgetaryError:
    err_block = (body or {}).get("error") or {}
    code = err_block.get("code") or _default_code_for_status(status)
    message = err_block.get("message") or f"Budgetary API returned HTTP {status}"
    request_id = err_block.get("request_id") or headers.get("x-request-id")

    kwargs = dict(code=code, message=message, http_status=status, request_id=request_id)

    if status in (401, 403):
        return BudgetaryAuthError(**kwargs)
    if status == 404:
        return BudgetaryNotFoundError(**kwargs)
    if status in (400, 409, 413):
        return BudgetaryValidationError(**kwargs)
    if status == 429:
        return BudgetaryRateLimitError(
            **kwargs,
            retry_after_seconds=_parse_retry_after(headers.get("retry-after")),
        )
    if status >= 500:
        return BudgetaryServerError(**kwargs)
    return BudgetaryError(**kwargs)


class HttpClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        timeout_ms: int,
        max_retries: int,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout_ms = timeout_ms
        self._max_retries = max_retries
        self._owned_client = http_client is None
        self._client = http_client or httpx.Client()

    def close(self) -> None:
        if self._owned_client:
            self._client.close()

    def request(
        self,
        *,
        method: str,
        path: str,
        json_body: Any | None = None,
        params: dict[str, Any] | None = None,
        timeout_ms: int | None = None,
        parse: Callable[[Any], T],
    ) -> T:
        return with_retry(
            lambda: self._attempt(
                method=method,
                path=path,
                json_body=json_body,
                params=params,
                timeout_ms=timeout_ms,
                parse=parse,
            ),
            max_retries=self._max_retries,
        )

    def _attempt(
        self,
        *,
        method: str,
        path: str,
        json_body: Any | None,
        params: dict[str, Any] | None,
        timeout_ms: int | None,
        parse: Callable[[Any], T],
    ) -> T:
        url = self._base_url + path
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
        }
        if json_body is not None:
            headers["Content-Type"] = "application/json"

        timeout_seconds = (timeout_ms or self._timeout_ms) / 1000.0

        clean_params: dict[str, Any] | None = None
        if params is not None:
            clean_params = {}
            for key, value in params.items():
                if value is None:
                    continue
                if isinstance(value, bool):
                    clean_params[key] = "true" if value else "false"
                else:
                    clean_params[key] = value

        try:
            response = self._client.request(
                method,
                url,
                headers=headers,
                json=json_body,
                params=clean_params,
                timeout=timeout_seconds,
            )
        except httpx.TimeoutException as err:
            raise BudgetaryNetworkError(
                code="timeout", message=f"request to Budgetary API timed out: {err}"
            ) from err
        except httpx.ConnectError as err:
            raise BudgetaryNetworkError(
                code="network",
                message=f"could not connect to Budgetary API: {err}",
            ) from err
        except httpx.RequestError as err:
            raise BudgetaryNetworkError(
                code="network",
                message=f"network error while contacting Budgetary API: {err}",
            ) from err

        body: dict[str, Any] | None = None
        text = response.text
        if text:
            try:
                body = response.json()
            except ValueError:
                body = None

        if response.status_code >= 400:
            raise _build_error(response.status_code, body, response.headers)

        try:
            return parse(body or {})
        except TypeError as err:
            raise BudgetaryError(
                code="schema_mismatch",
                message=f"unexpected response shape from Budgetary API: {err}",
                http_status=response.status_code,
                request_id=response.headers.get("x-request-id"),
            ) from err
