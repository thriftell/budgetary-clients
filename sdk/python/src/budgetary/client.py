"""Public ``BudgetaryClient`` against the v1 API contract."""

from __future__ import annotations

from dataclasses import fields
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

DEFAULT_BASE_URL = "https://api.budgetary.tools"
DEFAULT_TIMEOUT_MS = 10_000
# Total attempts = max_retries + 1; the contract's "give up after 5 attempts"
# (§8) → 4 retries. Kept in lockstep with the TypeScript SDK.
DEFAULT_MAX_RETRIES = 4

# Nested response objects are built with `**`, so an additive server field
# (contract §3: new fields may appear without notice) would raise TypeError.
# Filter each to the fields its dataclass declares. Derived from the dataclasses
# themselves, so these allow-lists can't drift from the types.
_DISTRIBUTION_FIELDS = frozenset(f.name for f in fields(Distribution))
_LEDGER_ACTUAL_FIELDS = frozenset(f.name for f in fields(LedgerActual))
_LEDGER_PREDICTED_FIELDS = frozenset(f.name for f in fields(LedgerPredicted))


def _known(data: dict[str, Any], allowed: frozenset[str]) -> dict[str, Any]:
    return {k: v for k, v in data.items() if k in allowed}


def _parse_estimate(body: dict[str, Any]) -> EstimateResponse:
    dist_body = body.get("distribution")
    distribution = (
        Distribution(**_known(dist_body, _DISTRIBUTION_FIELDS))
        if dist_body is not None
        else None
    )
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
    actual = (
        LedgerActual(**_known(actual_body, _LEDGER_ACTUAL_FIELDS))
        if actual_body is not None
        else None
    )
    return LedgerEntry(
        estimate_id=entry["estimate_id"],
        created_at=entry["created_at"],
        query_excerpt=entry["query_excerpt"],
        model=entry["model"],
        host=entry["host"],
        project_id=entry.get("project_id"),
        scenario=entry["scenario"],
        predicted=LedgerPredicted(**_known(entry["predicted"], _LEDGER_PREDICTED_FIELDS)),
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
        # Fail fast on a missing key rather than sending `Bearer ` and surfacing
        # an opaque 401 on the first call. Parity with the TypeScript SDK.
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError(
                "BudgetaryClient: `api_key` is required — pass a non-empty "
                "Budgetary API key."
            )
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
