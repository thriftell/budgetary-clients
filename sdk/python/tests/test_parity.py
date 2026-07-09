"""Parity with the TypeScript SDK + wire contract: scenario normalization,
constructor validation, additive-field tolerance, and body-parse robustness."""

from __future__ import annotations

import httpx
import pytest

from budgetary import (
    BudgetaryNetworkError,
    BudgetaryClient,
    normalize_scenario,
)


def test_normalize_scenario_folds_unknown_to_uncertain():
    for known in ("confident", "uncertain", "sparse_evidence", "out_of_domain"):
        assert normalize_scenario(known) == known
    # A label this SDK version doesn't recognize (contract §3: new labels may
    # appear without notice) folds to "uncertain" — same as the TS SDK.
    assert normalize_scenario("brand_new_label") == "uncertain"
    assert normalize_scenario("") == "uncertain"


def test_empty_api_key_raises_before_any_request():
    # Fail fast rather than sending `Bearer ` and getting an opaque 401.
    with pytest.raises(ValueError):
        BudgetaryClient(api_key="")
    with pytest.raises(ValueError):
        BudgetaryClient(api_key="   ")


def test_additive_server_fields_are_tolerated(respx_mock, client):
    # An unknown nested field (`unit_note`) and an unknown top-level field
    # (`experimental`) must not break parsing — the server may add fields.
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(
            200,
            json={
                "estimate_id": "est_x",
                "scenario": "confident",
                "void": False,
                "distribution": {
                    "p10": 1,
                    "p50": 2,
                    "p90": 3,
                    "unit": "tokens",
                    "unit_note": "future field",
                },
                "confidence": 0.9,
                "model": "m",
                "expires_at": "2026-05-27T10:14:00Z",
                "experimental": {"anything": True},
            },
        )
    )

    res = client.estimate("hi", client_request_id=None)
    assert res.distribution is not None
    assert res.distribution.p50 == 2


def test_empty_success_body_raises_network_error(respx_mock, client):
    # A 2xx with an empty JSON body can't be parsed into a response; surface it
    # inside the error taxonomy (a raw KeyError used to escape).
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, json={})
    )
    with pytest.raises(BudgetaryNetworkError):
        client.estimate("hi", client_request_id=None)


def test_non_json_success_body_raises_network_error(respx_mock, client):
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, text="not json at all")
    )
    with pytest.raises(BudgetaryNetworkError):
        client.estimate("hi", client_request_id=None)


def test_non_object_json_success_body_raises_network_error(respx_mock, client):
    # A 2xx whose JSON is valid but not an object (a list/string/number) can't
    # be parsed into a response; it must stay in the taxonomy rather than leak a
    # raw AttributeError from `.get(...)` on a non-dict.
    respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, json=[1, 2, 3])
    )
    with pytest.raises(BudgetaryNetworkError):
        client.estimate("hi", client_request_id=None)
