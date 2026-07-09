"""Single chokepoint for HTTP. Handles auth, error mapping, and retry orchestration."""

from __future__ import annotations

import json
import math
import time
from email.utils import parsedate_to_datetime
from typing import Any, Callable, TypeVar

import httpx

from budgetary.errors import (
    BudgetaryAuthError,
    BudgetaryError,
    BudgetaryNetworkError,
    BudgetaryNotFoundError,
    BudgetaryPermissionError,
    BudgetaryRateLimitError,
    BudgetaryServerError,
    BudgetaryValidationError,
)

from .retry import with_retry

T = TypeVar("T")

# Hard ceiling on a response body (8 MiB). The API's real responses are a few KB;
# a much larger body from a hostile or misbehaving endpoint is a memory-exhaustion
# vector, so the body is streamed and bounded rather than buffered whole.
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def _reject_non_finite(token: str) -> Any:
    """`json.loads` parse_constant hook: refuse the bare ``Infinity`` /
    ``-Infinity`` / ``NaN`` tokens from a hostile server instead of letting them
    flow into the numeric dataclasses."""
    raise ValueError(f"non-finite JSON constant: {token}")


def _reject_non_finite_float(token: str) -> float:
    """`json.loads` parse_float hook: refuse a numeric literal that OVERFLOWS to
    infinity (e.g. ``1e400``) — ``parse_constant`` only sees the bare keyword
    tokens, so this closes the overflow-to-``inf`` path into the dataclasses."""
    value = float(token)
    if not math.isfinite(value):
        raise ValueError(f"non-finite JSON number: {token}")
    return value


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

    if status == 401:
        return BudgetaryAuthError(**kwargs)
    if status == 403:
        # Distinct from 401 (bad key): a valid key lacking scope. A sibling of
        # BudgetaryAuthError (both under BudgetaryError), so the two are
        # distinguishable — matching the TS SDK. See contract §6.
        return BudgetaryPermissionError(**kwargs)
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

        # httpx's timeout is per-operation (connect / read / write), so a slow
        # drip could still run past it in wall-clock terms. Bound the whole
        # request with a monotonic deadline enforced while streaming the body.
        deadline = time.monotonic() + timeout_seconds
        raw = bytearray()
        try:
            with self._client.stream(
                method,
                url,
                headers=headers,
                json=json_body,
                params=clean_params,
                timeout=timeout_seconds,
                # Never follow a redirect: a hostile 3xx would re-send the request
                # (and the Authorization header) to its `Location`. Set explicitly
                # so a caller-supplied client with `follow_redirects=True` can't
                # re-enable it.
                follow_redirects=False,
            ) as response:
                declared = response.headers.get("content-length")
                if declared is not None:
                    try:
                        if int(declared) > MAX_RESPONSE_BYTES:
                            raise BudgetaryNetworkError(
                                code="network",
                                message="response body from Budgetary API exceeds the size limit",
                            )
                    except ValueError:
                        pass  # unparseable Content-Length: fall back to the streamed cap
                for chunk in response.iter_bytes():
                    raw.extend(chunk)
                    if len(raw) > MAX_RESPONSE_BYTES:
                        raise BudgetaryNetworkError(
                            code="network",
                            message="response body from Budgetary API exceeds the size limit",
                        )
                    if time.monotonic() > deadline:
                        raise BudgetaryNetworkError(
                            code="timeout",
                            message="request to Budgetary API exceeded its total deadline",
                        )
                status_code = response.status_code
                resp_headers = response.headers
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
        if raw:
            try:
                # `parse_constant` rejects Infinity/NaN; `errors="replace"` turns a
                # non-UTF-8 body into text that then fails to parse (→ body=None),
                # matching the prior "non-JSON body" handling.
                body = json.loads(
                    raw.decode("utf-8", errors="replace"),
                    parse_constant=_reject_non_finite,
                    parse_float=_reject_non_finite_float,
                )
            except ValueError:
                body = None

        if status_code >= 400:
            raise _build_error(status_code, body, resp_headers)

        try:
            return parse(body or {})
        except (TypeError, KeyError, AttributeError) as err:
            # A 2xx whose body is missing, non-JSON, a non-object JSON value
            # (list/str/number → AttributeError on `.get`), or missing a required
            # field is a truncated or malformed response — surface it inside the
            # error taxonomy as a network-class failure rather than letting a raw
            # exception escape. Additive/unknown fields are tolerated by the
            # parsers, so this only fires on a genuinely unusable body.
            raise BudgetaryNetworkError(
                code="network",
                message=f"unusable response body from Budgetary API: {err!r}",
            ) from err
