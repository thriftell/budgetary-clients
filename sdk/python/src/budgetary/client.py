"""Public ``BudgetaryClient`` against the v1 API contract."""

from __future__ import annotations

from typing import Any

import httpx

from budgetary._internal.http import HttpClient
from budgetary._internal.idempotency import _UNSET, resolve_client_request_id
from budgetary.types import (
    ActualsResponse,
    Distribution,
    EstimateContext,
    EstimateResponse,
    LedgerActual,
    LedgerEntry,
    LedgerPage,
    LedgerPredicted,
    LedgerQuery,
)

DEFAULT_BASE_URL = "https://api.budgetary.dev"
DEFAULT_TIMEOUT_MS = 10_000
DEFAULT_MAX_RETRIES = 5


def _parse_estimate(body: dict[str, Any]) -> EstimateResponse:
    dist_body = body.get("distribution")
    distribution = Distribution(**dist_body) if dist_body is not None else None
    return EstimateResponse(
        estimate_id=body["estimate_id"],
        scenario=body["scenario"],
        void=body["void"],
        distribution=distribution,
        confidence=body["confidence"],
        model=body["model"],
        expires_at=body["expires_at"],
    )


def _parse_actuals(body: dict[str, Any]) -> ActualsResponse:
    return ActualsResponse(
        received=body["received"],
        ledger_entry_id=body["ledger_entry_id"],
    )


def _parse_ledger_entry(entry: dict[str, Any]) -> LedgerEntry:
    actual_body = entry.get("actual")
    actual = LedgerActual(**actual_body) if actual_body is not None else None
    return LedgerEntry(
        estimate_id=entry["estimate_id"],
        created_at=entry["created_at"],
        query_excerpt=entry["query_excerpt"],
        model=entry["model"],
        host=entry["host"],
        project_id=entry.get("project_id"),
        scenario=entry["scenario"],
        predicted=LedgerPredicted(**entry["predicted"]),
        actual=actual,
    )


def _parse_ledger(body: dict[str, Any]) -> LedgerPage:
    return LedgerPage(
        entries=[_parse_ledger_entry(e) for e in body.get("entries", [])],
        next_cursor=body.get("next_cursor"),
    )


class BudgetaryClient:
    """Synchronous client for the Budgetary v1 API."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._http = HttpClient(
            api_key=api_key,
            base_url=base_url,
            timeout_ms=timeout_ms,
            max_retries=max_retries,
            http_client=http_client,
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "BudgetaryClient":
        return self

    def __exit__(self, *_exc_info: Any) -> None:
        self.close()

    def estimate(
        self,
        query: str,
        *,
        model: str | None = None,
        context: EstimateContext | None = None,
        client_request_id: Any = _UNSET,
        timeout_ms: int | None = None,
    ) -> EstimateResponse:
        body: dict[str, Any] = {"query": query}
        if model is not None:
            body["model"] = model
        if context is not None:
            body["context"] = dict(context)
        resolved = resolve_client_request_id(client_request_id)
        if resolved is not None:
            body["client_request_id"] = resolved

        return self._http.request(
            method="POST",
            path="/v1/estimate",
            json_body=body,
            timeout_ms=timeout_ms,
            parse=_parse_estimate,
        )

    def submit_actuals(
        self,
        *,
        estimate_id: str,
        tokens_in: int,
        tokens_out: int,
        success: bool,
        duration_ms: int,
        metadata: dict[str, Any] | None = None,
    ) -> ActualsResponse:
        body: dict[str, Any] = {
            "estimate_id": estimate_id,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "success": success,
            "duration_ms": duration_ms,
        }
        if metadata is not None:
            body["metadata"] = metadata

        return self._http.request(
            method="POST",
            path="/v1/actuals",
            json_body=body,
            parse=_parse_actuals,
        )

    def get_ledger(self, **query: Any) -> LedgerPage:
        # Accept either a `LedgerQuery` TypedDict expanded as kwargs or
        # individual keyword arguments. Unknown keys are forwarded; the
        # server is the authority on what it accepts.
        return self._http.request(
            method="GET",
            path="/v1/ledger",
            params=query,
            parse=_parse_ledger,
        )


__all__ = ["BudgetaryClient", "LedgerQuery"]
