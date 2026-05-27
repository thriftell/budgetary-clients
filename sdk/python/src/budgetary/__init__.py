class BudgetaryClient:
    """Thin client for the Budgetary API. Implementation lands in a later release."""

    def __init__(self, api_key: str, base_url: str = "https://api.budgetary.dev"):
        self.api_key = api_key
        self.base_url = base_url

    def estimate(self, query: str):
        raise NotImplementedError
