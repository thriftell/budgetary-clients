# Budgetary clients

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

**Budgetary tells you how many tokens an LLM query will cost — before you run it.**

Budgetary is a hosted API at `https://api.budgetary.dev` that returns probabilistic pre-inference token-spend estimates for LLM queries. This repository holds the open-source clients that talk to it: language SDKs and editor plugins.

## Quick example

```ts
import { BudgetaryClient } from "@budgetary/sdk";

const budgetary = new BudgetaryClient({ apiKey: process.env.BUDGETARY_API_KEY! });
const estimate = await budgetary.estimate("Summarize the attached PDF in three bullets.");
```

> The SDK in this release is a stub — the call above illustrates the shape of the API surface, not a working implementation.

## Install

See [docs/installation.md](docs/installation.md) for per-client setup:

- TypeScript / JavaScript SDK — `@budgetary/sdk` on npm
- Python SDK — `budgetary` on PyPI
- VS Code extension (dashboard)
- Claude Code plugin
- Codex plugin

## API

Bearer-auth HTTP API at `https://api.budgetary.dev`. The wire contract is published at [docs/api-contract.md](docs/api-contract.md).

## Status

**Early access.** The hosted API is live, but client interfaces may change between releases until they reach 1.0. Pin exact versions in production.

## License

[Apache-2.0](./LICENSE). Copyright Budgetary.
