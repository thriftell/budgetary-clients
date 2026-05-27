"""Shared pytest fixtures for the Python SDK test suite."""

from __future__ import annotations

from typing import Iterator

import httpx
import pytest
import respx

from budgetary import BudgetaryClient

TEST_API_KEY = "bg_test_dummy"
TEST_BASE_URL = "https://api.budgetary.test"


@pytest.fixture()
def respx_mock() -> Iterator[respx.MockRouter]:
    with respx.mock(
        base_url=TEST_BASE_URL, assert_all_called=False
    ) as router:
        yield router


@pytest.fixture()
def make_client():
    """Return a factory; tests pass overrides like ``max_retries=0``."""

    created: list[BudgetaryClient] = []

    def factory(**overrides) -> BudgetaryClient:
        params: dict = dict(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            max_retries=0,
        )
        params.update(overrides)
        client = BudgetaryClient(**params)
        created.append(client)
        return client

    yield factory

    for c in created:
        c.close()


@pytest.fixture()
def client(make_client) -> BudgetaryClient:
    return make_client()


@pytest.fixture()
def shared_httpx_client() -> Iterator[httpx.Client]:
    """An ``httpx.Client`` that callers can hand to ``BudgetaryClient``."""
    with httpx.Client() as c:
        yield c
