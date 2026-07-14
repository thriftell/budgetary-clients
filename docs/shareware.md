# Budgetary — Shareware model

> **What this governs.** How the **hosted Budgetary service** is offered. It is policy, not code: it governs *service usage*, not the source license of any repository. See [api-contract.md](api-contract.md) for the wire surface.

## The model in one line

**Free, unlimited, everyone contributes.** There is no payment gate on the estimate service. What we ask in return is data — that is the whole exchange, and it is why the service can be free.

## What "free and unlimited" means

- **Any valid API key is served.** `POST /v1/estimate` has no paywall, no plan, no trial to expire, and no usage cap that unlocks with money.
- **You do not have to take our word for it.** `GET /v1/meta` is unauthenticated and reports the service posture — `mode: "shareware"`, `price: "free"`. Check it yourself.
- **A subscription gate exists in the server, and it is off.** It is **off by default** (`BILLING_GATE_ENABLED`, default `false`), and when it is off every valid key reaches the engine. `BILLING_GATE_ENABLED=false` *is* shareware mode.

## What "everyone contributes" means

Stated concretely, because a promise this vague is worth nothing:

- **Your query text is stored.** The task description you send to `POST /v1/estimate` is retained — **encrypted at rest** — and joined to the realized token counts your client reports back to `POST /v1/actuals`.
- **It can enter the shared corpus.** A completed estimate — the task text, plus what the run actually cost — is eligible to be promoted into the corpus that answers **other users'** estimates. Your data improves their forecasts, and theirs improves yours. (An estimate on its own never enters the corpus; only one that has been joined to a real, successful outcome.)
- **This is on by default.** Query-text retention defaults to *retain*.
- **You can opt out, and it costs nothing.** An organization can be opted out of query-text retention. That is a **privacy control, not a paid tier** — it costs nothing and unlocks nothing.
- **Opting out means opting out of contributing.** An org whose text is not retained does not feed the corpus. The service still answers you; it simply does not learn from you.

If that trade is not one you want to make, the honest answer is that the hosted service is not for you.

## Encrypted at rest is not end-to-end

Said plainly, so that nobody reads more into it than is there. Your query text is encrypted at rest with a **server-held** key. That is **not** end-to-end encryption: we hold the key, and the ledger decrypts your own excerpt back to you. The stored embedding is not encrypted at all — retrieval runs on it.

## The code license is unchanged

Shareware governs **service usage only**. It does **not** change the license of any source code:

- **Public client repositories** remain **Apache-2.0**.
- **The private engine** remains **proprietary**.

Do not conflate "the service is shareware" with "the code is free software" — they are independent.

## This describes today

These are the **current** terms of the hosted service, not a perpetual guarantee. **Nothing is for sale today**: there is no product to buy, no plan, and no feature withheld behind one. If the terms change, this document changes first and says so.
