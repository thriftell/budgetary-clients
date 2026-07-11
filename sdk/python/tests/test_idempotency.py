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


def test_reuses_one_client_request_id_across_retries(
    respx_mock, make_client, monkeypatch
):
    """The invariant the cost story rests on: the id is resolved ONCE, outside the
    retry loop, so 500 → 500 → 200 replays the SAME client_request_id and the
    server dedups instead of double-billing. Uses the DEFAULT (auto-generated) id
    — every other retry test opts out with ``client_request_id=None``, so a
    refactor moving key resolution into the attempt loop would pass CI while
    silently re-billing. Parity with the TS SDK's no-rebill test."""
    # Inject a no-op sleep so the two backoffs don't add real seconds.
    import budgetary._internal.http as http_mod
    from budgetary._internal.retry import with_retry as _real_with_retry

    def _fast_with_retry(fn, **kw):  # type: ignore[no-untyped-def]
        return _real_with_retry(fn, sleep=lambda _s: None, **kw)

    monkeypatch.setattr(http_mod, "with_retry", _fast_with_retry)

    err_body = {
        "error": {"code": "internal_error", "message": "boom", "request_id": "r"}
    }
    route = respx_mock.post("/v1/estimate").mock(
        side_effect=[
            httpx.Response(500, json=err_body),
            httpx.Response(500, json=err_body),
            httpx.Response(200, json=_OK_BODY),
        ]
    )

    client = make_client(max_retries=5)
    res = client.estimate("hello")  # DEFAULT id — no opt-out
    assert res.estimate_id == "est_idem"

    assert len(route.calls) == 3
    ids = [
        _json.loads(call.request.content).get("client_request_id")
        for call in route.calls
    ]
    # A real id was sent on every attempt AND all three were identical.
    assert all(isinstance(i, str) and i for i in ids)
    assert len(set(ids)) == 1
