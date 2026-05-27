"""Dataclasses and typed dicts for the Budgetary v1 API.

Field names match the wire protocol exactly (snake_case); no case conversion
happens anywhere in the SDK.

The ``scenario`` field on responses is typed as ``str`` rather than a
``Literal[...]`` union because the contract says new labels may be added
without notice. Callers should treat any value outside the known set
(``"confident"``, ``"uncertain"``, ``"sparse_evidence"``, ``"out_of_domain"``)
as ``"uncertain"``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, TypedDict


class EstimateContext(TypedDict, total=False):
    host: str
    project_id: str
    depth_budget: int


@dataclass(frozen=True)
class Distribution:
    p10: int
    p50: int
    p90: int
    unit: Literal["tokens"]


@dataclass(frozen=True)
class EstimateResponse:
    estimate_id: str
    scenario: str
    void: bool
    distribution: Distribution | None
    confidence: float
    model: str
    expires_at: str


class ActualsRequest(TypedDict, total=False):
    estimate_id: str
    tokens_in: int
    tokens_out: int
    success: bool
    duration_ms: int
    metadata: dict[str, Any]


@dataclass(frozen=True)
class ActualsResponse:
    received: bool
    ledger_entry_id: str


class LedgerQuery(TypedDict, total=False):
    project_id: str
    host: str
    after: str
    limit: int
    include_orphans: bool
    since: str


@dataclass(frozen=True)
class LedgerPredicted:
    p10: int
    p50: int
    p90: int


@dataclass(frozen=True)
class LedgerActual:
    tokens_in: int
    tokens_out: int
    total: int
    duration_ms: int
    success: bool


@dataclass(frozen=True)
class LedgerEntry:
    estimate_id: str
    created_at: str
    query_excerpt: str
    model: str
    host: str
    project_id: str | None
    scenario: str
    predicted: LedgerPredicted
    actual: LedgerActual | None


@dataclass(frozen=True)
class LedgerPage:
    entries: list[LedgerEntry]
    next_cursor: str | None
