"""Happy-path coverage for the public ``BudgetaryClient`` methods."""

from __future__ import annotations

import httpx
import pytest

from budgetary import (
    ActualsResponse,
    BudgetaryValidationError,
    Distribution,
    EstimateResponse,
    LedgerActual,
    LedgerEntry,
    LedgerPage,
    LedgerPredicted,
)

TEST_API_KEY = "bg_test_dummy"


def _estimate_body() -> dict:
    return {
        "estimate_id": "est_01ABC",
        "scenario": "confident",
        "void": False,
        "distribution": {"p10": 100, "p50": 500, "p90": 2000, "unit": "tokens"},
        "confidence": 0.8,
        "model": "claude-opus-4-7",
        "expires_at": "2026-05-27T10:14:00Z",
    }


def test_estimate_sends_bearer_and_parses_response(respx_mock, client):
    route = respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, json=_estimate_body())
    )

    res = client.estimate(
        "write a haiku",
        model="claude-opus-4-7",
        context={"host": "sdk", "project_id": "proj_x", "depth_budget": 10},
        client_request_id="req_fixed",
    )

    assert isinstance(res, EstimateResponse)
    assert res.estimate_id == "est_01ABC"
    assert res.scenario == "confident"
    assert res.void is False
    assert isinstance(res.distribution, Distribution)
    assert res.distribution.p50 == 500
    assert res.expires_at == "2026-05-27T10:14:00Z"

    assert route.called
    sent = route.calls.last.request
    assert sent.method == "POST"
    assert sent.url.path == "/v1/estimate"
    assert sent.headers["authorization"] == f"Bearer {TEST_API_KEY}"
    assert sent.headers["content-type"].startswith("application/json")
    import json as _json

    body = _json.loads(sent.content)
    assert body == {
        "query": "write a haiku",
        "model": "claude-opus-4-7",
        "context": {"host": "sdk", "project_id": "proj_x", "depth_budget": 10},
        "client_request_id": "req_fixed",
    }


def test_estimate_forwards_optional_language_in_context(respx_mock, client):
    route = respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, json=_estimate_body())
    )

    client.estimate(
        "write a haiku",
        context={"host": "sdk", "language": "Python"},
        client_request_id="req_fixed",
    )

    import json as _json

    body = _json.loads(route.calls.last.request.content)
    # Forwarded verbatim on the wire as snake-case-safe "language".
    assert body["context"] == {"host": "sdk", "language": "Python"}


def test_estimate_void_response_does_not_raise(respx_mock, client):
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(
            200,
            json={
                "estimate_id": "est_void",
                "scenario": "out_of_domain",
                "void": True,
                "distribution": None,
                "confidence": 0.0,
                "model": "claude-opus-4-7",
                "expires_at": "2026-05-27T10:14:00Z",
            },
        )
    )

    res = client.estimate("???", client_request_id=None)
    assert res.void is True
    assert res.distribution is None


def test_estimate_rejects_empty_query_without_hitting_wire(respx_mock, client):
    # E-2: an empty/whitespace query can only earn a billed 400, so it is
    # rejected LOCALLY. respx would record a call if one were made; assert none is.
    route = respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, json=_estimate_body())
    )
    for q in ["", "   ", "\n\t "]:
        with pytest.raises(BudgetaryValidationError) as excinfo:
            client.estimate(q)
        # http_status None marks it client-side — the request never left.
        assert excinfo.value.http_status is None
    assert not route.called


def test_estimate_accepts_query_with_surrounding_whitespace(respx_mock, client):
    # The guard rejects only EMPTY/whitespace-only input; real content with
    # surrounding spaces still goes to the wire unchanged.
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, json=_estimate_body())
    )
    res = client.estimate("  real task  ", client_request_id=None)
    assert isinstance(res, EstimateResponse)


def test_submit_actuals_posts_body_and_parses_202(respx_mock, client):
    route = respx_mock.post("/v1/actuals").mock(
        return_value=httpx.Response(
            202, json={"received": True, "ledger_entry_id": "led_999"}
        )
    )

    res = client.submit_actuals(
        estimate_id="est_01ABC",
        tokens_in=12340,
        tokens_out=36210,
        success=True,
        duration_ms=420_000,
        metadata={"tool_calls": 47},
    )

    assert isinstance(res, ActualsResponse)
    assert res.received is True
    assert res.ledger_entry_id == "led_999"

    import json as _json

    body = _json.loads(route.calls.last.request.content)
    assert body == {
        "estimate_id": "est_01ABC",
        "tokens_in": 12340,
        "tokens_out": 36210,
        "success": True,
        "duration_ms": 420_000,
        "metadata": {"tool_calls": 47},
    }


def test_get_ledger_sends_query_params_and_parses_entries(respx_mock, client):
    route = respx_mock.get("/v1/ledger").mock(
        return_value=httpx.Response(
            200,
            json={
                "entries": [
                    {
                        "estimate_id": "est_01",
                        "created_at": "2026-05-26T03:14:00Z",
                        "query_excerpt": "fix the flaky test",
                        "model": "claude-opus-4-7",
                        "host": "claude-code",
                        "project_id": "proj_kx7",
                        "scenario": "confident",
                        "predicted": {"p10": 100, "p50": 500, "p90": 2000},
                        "actual": {
                            "tokens_in": 120,
                            "tokens_out": 380,
                            "total": 500,
                            "duration_ms": 9000,
                            "success": True,
                        },
                    }
                ],
                "next_cursor": None,
            },
        )
    )

    page = client.get_ledger(
        project_id="proj_kx7", host="claude-code", limit=50, include_orphans=True
    )

    assert isinstance(page, LedgerPage)
    assert page.next_cursor is None
    assert len(page.entries) == 1
    entry = page.entries[0]
    assert isinstance(entry, LedgerEntry)
    assert isinstance(entry.predicted, LedgerPredicted)
    assert isinstance(entry.actual, LedgerActual)
    assert entry.actual.tokens_in == 120

    sent = route.calls.last.request
    assert sent.method == "GET"
    assert sent.url.params["project_id"] == "proj_kx7"
    assert sent.url.params["host"] == "claude-code"
    assert sent.url.params["limit"] == "50"
    assert sent.url.params["include_orphans"] == "true"


def test_supports_context_manager_protocol(make_client, respx_mock):
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, json=_estimate_body())
    )

    with make_client() as c:
        res = c.estimate("hi", client_request_id=None)
    assert res.estimate_id == "est_01ABC"
