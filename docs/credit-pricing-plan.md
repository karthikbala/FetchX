# Credit pricing implementation

Approved 4 November 2026. This replaces the unreleased prepaid-GB proposal.

## Commercial contract

| One-time USD payment | Paid credits | Discount per credit versus $2 |
| --- | ---: | ---: |
| $2 | 10,000 | — |
| $8 | 50,000 | 20% |
| $20 | 150,000 | 33.3% |
| $100 | 1,000,000 | 50% |

Paid credits have no automatic renewal or scheduled expiry. Existing trial
credits retain their own rules and history. Verified live Stripe payments grant
paid credits exactly once; sandbox evidence never grants spendable credits.

Native HTTP uses a versioned tariff. Direct/reviewed datacenter costs one credit
per started 1,000,000 metered bytes, with a default total transfer limit of that
size. Residential costs five credits per started 250,000 metered bytes, with a
default total transfer limit of that size. Meter total bidirectional network
traffic across the operation, including redirects and proxied DNS. Explicit
`max_transfer_mb` can increase the limit to at most 20 decimal MB; `max_credits`
is a customer ceiling. Reserve the full quoted ceiling before dispatch and
settle measured usage once. Keep decoded/output sizes bounded independently.

Validation and proven non-dispatch cost zero. Source failures and size-limit
aborts consume verified usage within the ceiling. FetchX-owned failures release
customer credits without altering provider financial evidence. Uncertain work
retains its reservation and is never automatically redispatched. Exact replay
returns the original outcome without another debit.

Browser time at five additional credits per started ten seconds is provisional.
It must not become purchasable without existing transport qualification and
measured compute/licence economics. Paid LLM/OCR/third-party services need an
explicit quote and ceiling; no unlimited add-on is implied.

## Delivery and ownership

1. Paid-credit owner replaces the unreleased byte ledger with credit grants,
   immutable tariff reservations, usage/reversal/hold accounting, and evidence-
   based reconciliation. Existing trial and provider ledgers remain intact.
2. Gateway owner integrates quoting and whole-operation metering, completes
   bounded public-URL HTTPS GET/HEAD profiles, and preserves DNS pinning,
   private-network rejection, project isolation, and conservative provider caps.
3. Stripe owner wires the credit ledger into signed payment fulfillment and
   preserves uncertain-Checkout recovery, exact account/mode/Price checks,
   refunds, disputes, and sales-capacity accounting. One credit represents at
   most 50,000 bytes of residential supplier liability for capacity checks.
4. Website owner updates the packages, rate/discount explanation, trial versus
   paid balances, purchase history, transfer controls, and actionable limit
   errors. Availability comes from backend capabilities, not marketing flags.
5. Lead reviews diffs and evidence, runs serial disposable-PostgreSQL regression
   checks and UI verification, then prepares the scoped release. Production
   activation additionally needs real Stripe credentials/delivery and reviewed
   usable provider capacity. Unfinished features cannot be included in a release.

No production provider spending cap is raised by this document. No additional
provider credit, browser subscription, or external extraction service is bought.

## Acceptance

- Exact approved packages and monetary/credit units agree across Checkout,
  payment receipts, ledger, account UI, and public pricing.
- Measured bytes at and across block boundaries, redirects, size aborts, source
  errors, uncertain transport, crash recovery, and same-key replay have distinct
  verified outcomes without a negative balance or duplicate debit.
- Concurrent requests and purchases cannot overspend credits or approved supply;
  refund/dispute races cannot grant or spend revoked capacity.
- Public URLs cannot reach private/control destinations through literals, mixed
  DNS answers, rebinding, redirects, credentials, or alternate ports.
- Trial/private API compatibility and existing identities/history are preserved.
- Tests use synthetic sources/providers and run serially on an explicitly
  disposable `gateway_test_*` PostgreSQL database. No paid calls or secrets in CI.
- Stripe sandbox success is distinct from real live-payment acceptance and from
  source/content acceptance.
