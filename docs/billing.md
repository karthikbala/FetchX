# Billing

A request is charged only when it succeeds, at the price of the step that got the data (plus the page text read, when it asks for `extract`). Everything else is free: refused calls, blocked or failed requests, pages without what the caller's `expect` asked for or without a required `extract` field (`content_missing`), requests refused or failed because extraction could not run (`extract_unavailable`), uncertain outcomes, and every earlier step of a request that did succeed.

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
| `extract`, per started `extract_unit_tokens` (25,000) of page text the models read, at least one, up to `extract_max_tokens` (150,000) | 10 |
| `browser_session` (a browser session on a datacenter exit, flat) | 10 |
| `browser_session_residential` (on a residential exit, 5 MB included) | 25 |

A browser session (`POST /v1/browser-sessions`) is charged once, when it ends, whatever closed it (the caller, its TTL, idle or disconnect, its traffic limit), unless its browser failed (`close_reason: error`) or the create's answer was lost: then it is free. Its price is held while it runs; a residential session also holds the traffic its `max_credits` allows, and the engine closes it at that traffic. See [API: browser sessions](api.md#browser-sessions). The two session prices are placeholders until the owner sets them; they are `config.pricing` values like the others.

Extraction is priced on the engine's `usage.extract.page_tokens` (4 characters a token, counted by FetchX, so the price does not depend on the model). The engine reads at most 150,000 tokens, so it costs at most 60 credits; a request with `extract` reserves that on top of its steps, and a step is sent only when it and one unit fit the reservation. A next page reserves for extraction when the earlier request had `extract` (`fetch_settlements.extract`). At the largest pack's rate a unit (10 credits) is $0.001. The eval on 2026-11-21 measured about $0.0004 a page with Liquid d1.2, so a typical page leaves a margin; a full 25,000-token unit read by both d1.2 routes, or a chat fallback ($0.001 to $0.0025 of input), can cost as much as the unit or more. The engine's `extract.*` budgets cap that spend.

Most of a browser page's price past the step is residential traffic: a large travel search page settled at about 13 MB plus about 0.7 MB per screen scrolled, which is how a 25-credit step became 90 to 135 credits. The engine's `block_resources` (on unless a screenshot is asked for) refuses the page's own images, media and fonts at its request gate, so they are never downloaded; frames such as captchas keep theirs. Measured live on 2026-11-21, it took that page from 14.4 MB to 11.4 MB (75 to 60 credits) with the same results; the rest is scripts and data the page needs.

Each settled success stores its `wire_bytes` in `fetch_settlements`, and every answer shows `credits.breakdown` (`priceParts` in `src/billing/ledger.mjs`): `step`, `step_credits`, `captcha_credits`, `traffic_mb`, `included_mb`, `traffic_credits`, `extract_tokens` (null without `extract`) and `extract_credits`, which add up to `charged` unless the reservation capped it.

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

Scrolling within a page (`scroll`) has no fee, but what a scrolled page loads is wire traffic like any other, so on a residential route it counts toward `residential_overage_per_mb` (Karthik, 2026-11-20). A page read deeper than 10 screens may load more (the engine allows 2.5 MB more traffic a screen past 10, at most 150 MB), so its reservation covers that traffic: `scroll: 30` reserves for 80 MB. A next page (`POST /v1/fetch/{id}/next`) is a request of its own: its depth is the engine's replay, so it is reserved at admission for the deepest page (150 MB), charged at its winning step and the traffic it actually used only when it succeeds, released otherwise. `max_credits` caps both the reservation and the charge. `max_credits` is not carried over from the earlier request.

Projects provisioned in `config.projects` are unmetered: nothing is reserved or charged.

## Trial and purchases

Every verified account gets `controlPlane.creditPolicy.trialCredits` (1,000, a [budget](budgets.md) operators can change in the admin portal) once, on its oldest active project (`src/billing/trial.mjs`); the receipt is per user, so deleting and recreating projects never grants twice.

Credit packs are one-time Stripe Checkout payments: $2, $8, $20 and $100 (or the INR equivalents with UPI) for 10,000, 50,000, 150,000 and 1,000,000 credits. A verified live payment adds a grant (`Purchases.grantPaidCredits`); a refund or lost dispute revokes it; sandbox payments change nothing. See [Stripe payments](stripe-payments.md) and [INR UPI](inr-upi-backend.md).

## Usage

`GET /v1/balance` answers what is available now (`credits`, null for an unmetered project), what is reserved by running requests, the trial and purchased totals, and `payment_hold`. Every fetch answer also carries `credits.balance`, the available credits at the time it was read.

`GET /v1/usage` (and the console's Credits & usage page) reports the balance, the period's credits used, succeeded and failed requests, captchas solved, credits by step and by day.

## Operator corrections

Inside the platform container:

```sh
node src/operator.mjs credits cp_<project-id> 500 "goodwill credit for incident 42"
node src/operator.mjs credits cp_<project-id> -200 "duplicate grant"
```

Each adjustment is recorded with its note and `FETCHX_OPERATOR` (default `operator-cli`) and prints the new balance.
