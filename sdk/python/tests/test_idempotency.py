"""Behavior of ``client_request_id``: auto-generate, pass-through, opt-out."""

from __future__ import annotations

import json as _json
import re
import uuid

import httpx


_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


_OK_BODY = {
    "estimate_id": "est_idem",
    "scenario": "confident",
    "void": False,
    "distribution": {"p10": 1, "p50": 2, "p90": 3, "unit": "tokens"},
    "confidence": 0.5,
    "model": "claude-opus-4-7",
    "expires_at": "2026-05-27T10:14:00Z",
}


def _last_body(route) -> dict:
    return _json.loads(route.calls.last.request.content)


def test_auto_generates_uuid_when_unset(respx_mock, client):
    route = respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, json=_OK_BODY)
    )

    client.estimate("hello")

    body = _last_body(route)
    cid = body["client_request_id"]
    assert isinstance(cid, str)
    assert _UUID_RE.match(cid)
    # Confirm it parses as a valid UUID v4.
    parsed = uuid.UUID(cid)
    assert parsed.version == 4


def test_preserves_caller_supplied_value(respx_mock, client):
    route = respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, json=_OK_BODY)
    )

    client.estimate("hello", client_request_id="req_explicit_1")

    body = _last_body(route)
    assert body["client_request_id"] == "req_explicit_1"


def test_omits_field_when_none(respx_mock, client):
    route = respx_mock.post("/v1/estimate").mock(
        return_value=httpx.Response(200, json=_OK_BODY)
    )

    client.estimate("hello", client_request_id=None)

    body = _last_body(route)
    assert "client_request_id" not in body
