from budgetary import BudgetaryClient


def test_client_constructs_with_defaults():
    client = BudgetaryClient(api_key="test-key")
    assert client.api_key == "test-key"
    assert client.base_url == "https://api.budgetary.dev"


def test_client_accepts_custom_base_url():
    client = BudgetaryClient(api_key="test-key", base_url="https://staging.budgetary.dev")
    assert client.base_url == "https://staging.budgetary.dev"
