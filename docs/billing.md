# Billing

A request is charged only when it succeeds, at the price of the step that got the data. Everything else is free: refused calls, blocked or failed requests, uncertain outcomes, and every earlier step of a request that did succeed.

## Prices

`DEFAULT_PRICES` in `src/billing/ledger.mjs`, overridable with `config.pricing`:

| Step | Credits |
| --- | ---: |
| `http` (direct or datacenter) | 1 |
| `http_residential` | 5 |
| `browser` (datacenter or direct) | 10 |
| `browser_residential` | 25 |
| `captcha`, added when the winning step solved one | 10 |
| `residential_overage_per_mb`, beyond `residential_included_mb` (1 MB for HTTP, 5 MB for a browser) | 5 per started MB |

## The balance

One balance per project, computed by `Ledger.balance`:

```
trial (control_credit_accounts.granted_credits)
+ purchased (live Stripe grants not revoked, paid_credit_grants)
+ adjustments (credit_adjustments: opening balances carried over at launch, operator corrections)
- charges (credit_charges)
- open reservations (credit_reservations)
```

A request reserves at admission (`FetchFront.submit`, in one transaction with its `fetch_settlements` row): the smallest of `max_credits`, the most expensive step's worst case and the available balance. The job goes to the engine with `allowed_steps`, the cost tiers that reservation covers, and the engine skips the rest (`over_max_credits`). If no tier the job needs is covered, the engine refuses it before anything is sent and the platform answers `402 insufficient_credits` (with `available` and `needed`) or `402 max_credits_too_low` (with `min_credits`). A payment hold (an open dispute or a pending refund) answers `402 payment_hold`.

The job's `usage` (the winning step, whether it solved a captcha, its wire bytes) arrives with the engine's signed `job.finished` event, or from the engine when the result is read or the reconciler looks it up. Settlement happens once per job: on success `Ledger.charge` records the price (never more than the reservation) and removes the reservation; otherwise `Ledger.release` removes it. A job the engine never started is released by the reconciler; one whose fate is unknown stays reserved until the engine confirms it.

Projects provisioned in `config.projects` are unmetered: nothing is reserved or charged.

## Trial and purchases

Every verified account gets `controlPlane.creditPolicy.trialCredits` (1,000) once, on its oldest active project (`src/billing/trial.mjs`); the receipt is per user, so deleting and recreating projects never grants twice.

Credit packs are one-time Stripe Checkout payments: $2, $8, $20 and $100 (or the INR equivalents with UPI) for 10,000, 50,000, 150,000 and 1,000,000 credits. A verified live payment adds a grant (`Purchases.grantPaidCredits`); a refund or lost dispute revokes it; sandbox payments change nothing. See [Stripe payments](stripe-payments.md) and [INR UPI](inr-upi-backend.md).

## Usage

`GET /v1/usage` (and the console's Credits & usage page) reports the balance, the period's credits used, succeeded and failed requests, captchas solved, credits by step and by day.

## Operator corrections

Inside the platform container:

```sh
node src/operator.mjs credits cp_<project-id> 500 "goodwill credit for incident 42"
node src/operator.mjs credits cp_<project-id> -200 "duplicate grant"
```

Each adjustment is recorded with its note and `FETCHX_OPERATOR` (default `operator-cli`) and prints the new balance.
