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

A request reserves at admission (`Ledger.reserve`), between the cheapest planned step and the smallest of `max_credits` and the most expensive one. If the balance cannot cover the cheapest step the call is refused with `402 insufficient_credits` before anything is sent. On success `Ledger.charge` records the price (never more than the reservation) and removes the reservation; otherwise `Ledger.release` removes it. Startup releases reservations left by a stopped process (`releaseOrphans`). A payment hold (an open dispute or a pending refund) makes `reserve` refuse with `402 payment_hold`.

Projects provisioned in `config.projects` are unmetered: nothing is reserved or charged.

## Trial and purchases

Every verified account gets `controlPlane.creditPolicy.trialCredits` (1,000) once, on its oldest active project (`src/billing/trial.mjs`); the receipt is per user, so deleting and recreating projects never grants twice.

Credit packs are one-time Stripe Checkout payments: $2, $8, $20 and $100 (or the INR equivalents with UPI) for 10,000, 50,000, 150,000 and 1,000,000 credits. A verified live payment adds a grant (`Purchases.grantPaidCredits`); a refund or lost dispute revokes it; sandbox payments change nothing. See [Stripe payments](stripe-payments.md) and [INR UPI](inr-upi-backend.md).

## Usage

`GET /v1/usage` (and the console's Credits & usage page) reports the balance, the period's credits used, succeeded and failed requests, captchas solved, credits by step and by day.

## Operator corrections

Inside the gateway container:

```sh
node src/operator.mjs credits cp_<project-id> 500 "goodwill credit for incident 42"
node src/operator.mjs credits cp_<project-id> -200 "duplicate grant"
```

Each adjustment is recorded with its note and `FETCHX_OPERATOR` (default `operator-cli`) and prints the new balance.
