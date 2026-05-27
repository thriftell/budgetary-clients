# budgetary

Python SDK for the [Budgetary](https://api.budgetary.dev) API. Provides a thin client for pre-inference token-spend estimates. This release ships a stub class so the package is importable; real methods land in a later version.

```python
from budgetary import BudgetaryClient

client = BudgetaryClient(api_key="...")
```

Licensed under [Apache-2.0](../../LICENSE).
