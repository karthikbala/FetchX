# INR and UPI checkout

Approved prices: ₹0 / 1,000 once-per-verified-account trial; ₹175 / 10,000, ₹750 / 50,000, ₹1,800 / 150,000, ₹9,000 / 1,000,000 prepaid credits. Rates per 1,000 credits: ₹17.50, ₹15, ₹12, ₹9. Discounts against the first paid pack: 14.3%, 31.4%, 48.6%. Existing USD packs remain unchanged.

Cloudflare request country IN selects INR with UPI-only hosted Checkout; other or unknown countries select USD/card. Show one price currency at a time, with no USD flash or browser-controlled country header. Country is a storefront routing hint, not proof of residency or tax status. Existing saved checkouts and purchase history retain the original billed currency. No adaptive conversion or automatic renewal; purchased credits have no scheduled expiry.

Implementation order:
1. Extend the explicit offer/price/currency/method contract, ledger constraints and payment outcome reconciliation, preserving legacy USD forms and idempotency.
2. Add trusted country forwarding and country-specific public/billing pricing, including failed/pending/recovery UI.
3. Test INR success/failure/expiry, currency and amount tampering, duplicate/out-of-order events, refunds/disputes, legacy USD recovery, and shared provider liability. Run PostgreSQL tests serially against disposable gateway_test_* databases only.
4. Prepare separate test/live INR Prices, method activation and webhook subscriptions; preserve Cloudflare-only Stripe secrets and rate limits.
5. Stage compatible code with new INR sales disabled; verify sandbox hosted UPI and unchanged USD controls, then enable reviewed INR offers. A rollback disables new INR sales while retaining reconciliation for existing payments.

All purchases share the existing credit wallet and conservative provider-capacity reservation. No new provider allowance, source calls or crawl restarts are part of this change. Backups stay on servers/Storage Box.

Planning economics: residential provider cost $1/GB, conservative liability 50,820 bytes/credit, ₹100/USD cost assumption (not a quoted exchange rate), and 5% UPI processing/conversion allowance. Estimated contribution after provider and payment costs is 66.0%, 61.1%, 52.7%, 38.5%; hosting, support and applicable taxes are excluded. Confirm actual Stripe terms and tax treatment before publishing final commercial claims.

Lead owns contract decisions, integration review and release. Core worker owns gateway/ledger/Stripe broker; website worker owns Pages/frontend/country forwarding. Release preparation is isolated in private operator files. Workers do not mutate production.
