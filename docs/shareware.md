# Budgetary — Shareware model

> **What this governs.** This document describes how the **hosted Budgetary service** is offered. It is policy, not code: it governs *service usage*, not the source license of any repository. See [api-contract.md](api-contract.md) for the wire surface.

## The model in one line

**Free, unlimited, everyone contributes** — the WinRAR shape. There is no payment gate on the estimate service, and every served estimate is eligible to thicken the corpus.

## What this means

- **Free and unlimited for everyone.** Any valid API key is served `POST /v1/estimate`. There is no paywall and no opt-out-of-contribution paywall. The marginal cost of an estimate is near-zero — the expensive AI inference is the *caller's*, not ours — so serving the long tail is cheap and each estimate grows the dataset.
- **Everyone contributes.** Query-text retention defaults to *retain* (per-org), and served estimates are eligible to be promoted into the corpus that improves future estimates. An operator can opt a specific org out of text retention; that is a privacy control, not a tier.
- **Machine-readable mode signal.** `GET /v1/meta` advertises the posture (`mode: "shareware"`, `price: "free"`) plus config-driven policy links, so clients can render the model honestly. It is unauthenticated and carries **no engine internals**.

## How this is enforced in code

The estimate service is **already ungated**. The subscription gate is **OFF by default** (`BILLING_GATE_ENABLED`, default `false`): when off, every valid key reaches the engine.

- **`BILLING_GATE_ENABLED=false` (default) *is* shareware mode.**
- **`BILLING_GATE_ENABLED=true` is reserved** for the **future enterprise-license enforcement** (see below).

## The code license is unchanged

Shareware governs **service usage only**. It does **not** change the license of any source code:

- **Public client repositories** remain **Apache-2.0**.
- **The private engine** remains **proprietary**.

Do not conflate "the service is shareware" with "the code is free software" — they are independent.

## Where the revenue comes from

1. **The license itself (future).** What an enterprise, bank, or government ultimately buys is the **legal/compliance legitimacy** of a licensed deployment (unlicensed-software audit, procurement, and security risk is the real pain). That commercial licensing is **out of scope here**. The dormant gate above is its eventual enforcement point.
2. **Voluntary donation.** The only monetization is a **voluntary donation** — *defined but not built* here, and dormant by default. See the next section.

## Donation — defined, dormant, link-out only

The donation surface is a **single configurable link** (`/v1/meta.donate_url`, env `DONATE_URL`) pointing at a **third-party platform** (e.g. GitHub Sponsors / Ko-fi / Buy Me a Coffee / a Stripe Payment Link). The design is **fixed and minimal**:

- **Link-out only.** We never process payments, never store donor or recipient financial PII, and never see card data. The platform owns KYC, payout, and disclosure.
- **Dormant by default.** `DONATE_URL` is unset → `/v1/meta.donate_url = null` → clients show **no** donate affordance. Shipping with donation dormant is the expected first state.
