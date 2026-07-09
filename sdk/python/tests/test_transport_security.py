"""Transport hardening: HTTPS enforcement, body cap, non-finite JSON rejection."""

from __future__ import annotations

import httpx
import pytest

from budgetary import BudgetaryClient, BudgetaryError, BudgetaryNetworkError

TEST_API_KEY = "bg_test_dummy"


def _estimate_body() -> dict:
    return {
        "estimate_id": "est_1",
        "scenario": "confident",
        "void": False,
        "distribution": {"p10": 1, "p50": 2, "p90": 3, "unit": "tokens"},
        "confidence": 0.5,
        "model": "m",
        "expires_at": "2026-05-27T10:14:00Z",
    }


class TestBaseUrlSchemeSafety:
    def test_refuses_non_https_non_localhost(self) -> None:
        with pytest.raises(ValueError, match="non-HTTPS"):
            BudgetaryClient(api_key=TEST_API_KEY, base_url="http://evil.example")

    def test_refuses_non_http_scheme(self) -> None:
        with pytest.raises(ValueError, match="non-HTTPS"):
            BudgetaryClient(api_key=TEST_API_KEY, base_url="file:///etc/passwd")

    def test_allows_https(self) -> None:
        BudgetaryClient(
            api_key=TEST_API_KEY, base_url="https://api.budgetary.tools"
        ).close()

    @pytest.mark.parametrize(
        "url", ["http://localhost:8787", "http://127.0.0.1:3000", "http://[::1]:9000"]
    )
    def test_allows_loopback_http(self, url: str) -> None:
        BudgetaryClient(api_key=TEST_API_KEY, base_url=url).close()

    def test_allows_insecure_opt_in(self) -> None:
        BudgetaryClient(
            api_key=TEST_API_KEY,
            base_url="http://staging.internal",
            allow_insecure=True,
        ).close()


class TestResponseHardening:
    @pytest.mark.parametrize("literal", [b"Infinity", b"-Infinity", b"NaN", b"1e400"])
    def test_rejects_non_finite_json_numbers(
        self, respx_mock, client, literal: bytes
    ) -> None:
        # A hostile server answers with a non-finite number — a bare token OR an
        # overflowing literal (1e400 → inf). Both must be refused rather than
        # flowing into the numeric dataclasses.
        respx_mock.post("/v1/estimate").mock(
            return_value=httpx.Response(
                200,
                content=(
                    b'{"estimate_id":"e","scenario":"confident","void":false,'
                    b'"distribution":{"p10":' + literal + b',"p50":1,"p90":2,"unit":"tokens"},'
                    b'"confidence":0.5,"model":"m","expires_at":"t"}'
                ),
                headers={"content-type": "application/json"},
            )
        )
        with pytest.raises(BudgetaryError):
            client.estimate("x", client_request_id=None)

    def test_does_not_follow_redirects_even_with_a_follow_redirects_client(
        self, respx_mock
    ) -> None:
        # A caller-supplied client configured to follow redirects must NOT cause
        # the bearer token to be re-sent to a 3xx `Location`.
        route = respx_mock.post("/v1/estimate").mock(
            return_value=httpx.Response(
                307, headers={"location": "https://evil.example/collect"}
            )
        )
        with httpx.Client(follow_redirects=True) as shared:
            c = BudgetaryClient(
                api_key=TEST_API_KEY,
                base_url="https://api.budgetary.test",
                max_retries=0,
                http_client=shared,
            )
            with pytest.raises(BudgetaryError):
                c.estimate("x", client_request_id=None)
        # Exactly one request was made — the redirect to evil.example was not followed.
        assert route.call_count == 1

    def test_caps_an_oversized_response_body(self, respx_mock, client) -> None:
        # A body far larger than any real response is a memory-exhaustion vector.
        respx_mock.post("/v1/estimate").mock(
            return_value=httpx.Response(
                200,
                content=b"{" + b" " * (9 * 1024 * 1024) + b"}",
                headers={"content-type": "application/json"},
            )
        )
        with pytest.raises(BudgetaryNetworkError, match="size limit"):
            client.estimate("x", client_request_id=None)

    def test_normal_body_still_parses(self, respx_mock, client) -> None:
        respx_mock.post("/v1/estimate").mock(
            return_value=httpx.Response(200, json=_estimate_body())
        )
        res = client.estimate("x", client_request_id=None)
        assert res.estimate_id == "est_1"
