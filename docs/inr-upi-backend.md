# INR UPI backend contract

India pricing uses independent one-time Stripe INR Prices; all other/unknown countries use the existing USD card offers. The control bridge supplies `X-FetchX-Client-Country` from trusted edge country metadata. Only exact `IN` selects INR. The browser submits a plan ID and idempotency key; it cannot submit an amount, currency or payment method.

| Offer ID | Currency | Minor units | Credits | Method |
| --- | --- | ---: | ---: | --- |
| credits-10000 | usd | 200 | 10,000 | card |
| credits-50000 | usd | 800 | 50,000 | card |
| credits-150000 | usd | 2000 | 150,000 | card |
| credits-1000000 | usd | 10000 | 1,000,000 | card |
| credits-10000-inr | inr | 17500 | 10,000 | upi |
| credits-50000-inr | inr | 75000 | 50,000 | upi |
| credits-150000-inr | inr | 180000 | 150,000 | upi |
| credits-1000000-inr | inr | 900000 | 1,000,000 | upi |

The `stripe.currency` billing field identifies the current display currency. New `stripe.plans` contains only that currency. If the INR catalog is absent, India gets an unavailable INR catalog rather than a USD fallback. Pending checkout and checkout response fields include the saved currency, amount and credits. Historical purchase amounts retain their original currencies. Saved orders can be recovered with their original key and form after geography changes; the current country only controls creation of a new order.

USD canonical forms and broker command signatures retain their existing bytes. INR canonical forms select `upi`; the Worker translates the deprecated canonical payment-method field to Stripe Endive's `allowed_payment_method_types[0]`. Amount, currency, approved Price, credit allowance and payment method are checked together. Adaptive pricing, arbitrary prices, coupons, taxes and currency conversion are not enabled by this contract.

Existing installations migrate only the recognized `paid_credit_grants_currency_check` USD constraint to USD/INR, and the recognized order state constraint to add terminal `failed`. Unknown constraint definitions stop initialization. Migrations preserve existing rows and can run repeatedly. Both currencies use one credit wallet and the existing shared provider liability pool, including pending and outstanding obligations.

UPI completion only grants credits after exact Session, line item, PaymentIntent and Charge evidence proves paid INR/UPI. Pending/unpaid UI completion is recorded without a grant. Confirmed `checkout.session.async_payment_failed` ends its unpaid order without granting credits. A UPI QR expires after five minutes and emits `payment_intent.payment_failed`; that does not imply its Checkout Session expired. The verified failure is acknowledged while the open Checkout and capacity reservation remain recoverable. Actual Session expiry releases the purchase slot.

UPI refunds are asynchronous. `refund.get` is read-only and validates the refund through its exact tagged Charge, PaymentIntent and Customer chain (Stripe Refund objects do not contain `livemode`). Pending/requires-action refunds hold spending; confirmed failure/cancellation clears only that refund's hold. Confirmed successful partial/full refunds retain the existing whole-pack revocation policy. Old/out-of-order webhook notifications read current Stripe objects and cannot restore revoked credits or clear unrelated dispute holds.

Before activating INR, the test and live webhook subscriptions must contain all eleven events:

- checkout.session.completed
- checkout.session.async_payment_succeeded
- checkout.session.async_payment_failed
- checkout.session.expired
- payment_intent.payment_failed
- charge.refunded
- refund.created
- refund.updated
- refund.failed
- charge.dispute.created
- charge.dispute.closed

The gateway `inrSalesEnabled` boolean defaults to false. Stage the eight-offer catalog and Worker price allowlist while INR sales stay disabled; set this flag true for new India orders. Setting it false again pauses only new INR orders while existing saved Checkout recovery, USD sales and all webhook reconciliation continue. Do not remove historical INR prices or the reconciliation contract to pause sales.

Cloudflare `STRIPE_PRICE_IDS` retains the four existing USD IDs and adds all four INR IDs for a live eight-offer deployment. Four-offer USD-only live deployments and scoped test subsets remain accepted. The gateway catalog and Worker price binding must match. Existing Stripe keys, webhook secrets and relay private keys remain exclusively in Cloudflare. Existing restricted permissions need read-only Refunds access; no refund/payout write operation is exposed.

Verification uses synthetic providers and serial disposable `gateway_test_*` PostgreSQL databases. The focused INR suite exercises the actual Worker, authenticated broker and signed webhook relay into PostgreSQL. It covers populated legacy migration, saved USD recovery under India geography, exact INR grants, pending/failure states, shared mixed-currency capacity, duplicate/out-of-order refunds, unrelated dispute holds, and QR expiry recovery. No real payment or provider work belongs in these tests.

Official references:

- [UPI](https://docs.stripe.com/payments/upi)
- [Checkout UPI integration](https://docs.stripe.com/payments/upi/accept-a-payment.md?payment-ui=checkout)
- [Refund object](https://docs.stripe.com/api/refunds/object)
