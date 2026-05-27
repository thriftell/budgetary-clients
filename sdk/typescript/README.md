# @budgetary/sdk

TypeScript SDK for the [Budgetary](https://api.budgetary.dev) API. Provides a thin, typed client for pre-inference token-spend estimates. This release ships a stub class so the package is importable; real methods land in a later version.

```ts
import { BudgetaryClient } from "@budgetary/sdk";

const client = new BudgetaryClient({ apiKey: process.env.BUDGETARY_API_KEY! });
```

Licensed under [Apache-2.0](../../LICENSE).
