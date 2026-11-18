# Stripe prepaid credits

## Packages

FetchX sells one-time prepaid credit packs. Paid balances carry forward without scheduled expiry or automatic renewal. The $0 free plan grants 1,000 trial credits once per account. Before a project's first verified live purchase, trial access uses its existing route and daily limits. When unified credits are enabled, that purchase combines the project's unspent trial credits with its purchased credits. A purchase in another project does not move credits or unlock the trial project.

| Package ID | USD price | Minor units | Credits |
| --- | ---: | ---: | ---: |
| `credits-10000` | $2 | 200 | 10,000 |
| `credits-50000` | $8 | 800 | 50,000 |
| `credits-150000` | $20 | 2,000 | 150,000 |
| `credits-1000000` | $100 | 10,000 | 1,000,000 |

A pack funds eligible public HTTP routes. Checkout verifies a ready route and approved residential capacity. The sales check budgets 50,820 residential provider bytes per credit across the selected pack, pending or uncertain live checkouts, and existing unspent paid credits, including credits reserved or held. That figure includes read padding for a default request. The customer tariff covers 250,000 bytes per five-credit block, equivalent to 50,000 bytes per credit within that block. Larger transfer ceilings with low measured usage, uncertain dispatches, and refunds can leave provider holds that require additional headroom and provider reconciliation. A project can buy only an eligible pack and have one pending Checkout per Stripe mode. Admission checks provider budgets and source restrictions when each request runs.

## Cloudflare payment Worker

Deploy `payments-worker/` as a dedicated Worker for one Stripe account and mode. The gateway uses the Worker's narrow broker API and receives signed webhook relays. Provision separate Worker environments, Stripe keys and signing material for sandbox and live use. Configure the exact HTTPS Worker hostname before opening sales.

| Worker binding | Purpose |
| --- | --- |
| `STRIPE_API_KEY` | Account-scoped restricted `rk_test_` or `rk_live_` key |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the Worker's Stripe destination |
| `STRIPE_RELAY_ED25519_PKCS8` | Relay private key as base64 PKCS#8 DER |
| `BROKER_AUTH_SECRET` | A scoped broker secret generated from 32 random bytes as unpadded base64url |
| `STRIPE_MODE`, `STRIPE_ACCOUNT_ID` | Exact Stripe scope |
| `STRIPE_PRICE_IDS` | JSON mapping approved package IDs to that scope's Stripe Price IDs. Configure all four in live mode and reconcile pending orders before rotating a mapped Price |
| `CHECKOUT_RETURN_ORIGIN` | Exact HTTPS origin used for the fixed billing return routes |
| `GATEWAY_RELAY_URL` | Exact HTTPS gateway URL ending in `/webhooks/stripe/relay` |
| `RELAY_KEY_ID` | Identifier for the Ed25519 signing key |

Store the first four values as Worker secrets. The broker validates a timestamped HMAC over the exact request bytes and dispatches a fixed operation. It builds the Stripe request from validated identifiers, the pinned Prices, and the configured website origin. It returns the fields needed for canonical receipt verification and the hosted URL for an open Checkout. Cloudflare rate bindings admit up to the configured thresholds of 120 authenticated broker commands and 20 creation commands per minute per location. These limits are approximate. [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Workers rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Use Stripe restricted permissions for Accounts, Prices, PaymentIntents, Charges and Refunds, and Payment Disputes at Read, and Customers and Checkout Sessions at Write. Checkout uses one active fixed one-time Price, a single quantity and the exact approved USD amount. Use the standard Stripe payment receipt settings for customer receipts. [Stripe API keys](https://docs.stripe.com/keys), [Stripe Checkout Session API](https://docs.stripe.com/api/checkout/sessions/create).

## Gateway configuration

Supply `controlPlane.stripe` in the gateway's private configuration. Omitting it leaves billing read-only.

| Field | Value |
| --- | --- |
| `transport` | `"broker"` |
| `enabled` | Set `true` after route, capacity and release approval |
| `mode`, `accountId` | Match the Worker deployment |
| `brokerUrl` | Exact HTTPS Worker URL ending in `/broker/v1` |
| `brokerReturnOrigin` | The Worker's configured website origin, also in `controlPlane.origins` |
| `brokerAuthSecret` | The Worker's scoped broker credential |
| `relayPublicKeys` | One or two `{keyId: base64-SPKI-DER}` public keys for verification and rotation |
| `commercialReviewed` | Required `true` to open live sales |
| `allowedProjects` | Approved existing project IDs. Required for sandbox and by default for live |
| `allowAllProjects` | Explicit live-only opt-in. Projects still need an approved, ready route |
| `catalog` | Entries with `id`, `name`, `version`, `priceId`, `amountMinor`, `currency: "usd"` and `credits` matching the package table |

The gateway broker configuration rejects Stripe API keys and Stripe signing secrets. The gateway verifies the Worker relay signature with the pinned public key. It still relies on its scoped broker credential, application credentials and PostgreSQL permissions. A fully compromised host could exercise the broker's allowed operations or change the local credit ledger. Control of the Worker deployment carries access to its configured secrets.

## Webhook destination

Create a Stripe snapshot event destination for direct events on the selected account. Set the destination to the **Worker** HTTPS URL ending in `/webhooks/stripe` and use API version `2026-10-28.endive`.

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

The Worker verifies the Stripe signature against the original raw bytes. It signs a minimal relay containing mode, account, event, subject and the original payload SHA-256. The gateway checks the Ed25519 signature and freshness before it inserts the event into the durable inbox. Stripe receives success after the inbox acknowledges the event. A gateway outage produces a failed delivery that Stripe can retry. An event ID with conflicting source evidence produces a failed delivery and retains the first receipt. [Stripe webhook setup](https://docs.stripe.com/events/set-up-events), [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).

After the inbox write, the gateway retrieves canonical Stripe objects through the broker. It verifies the saved project/customer, Checkout Session, Price and quantity, captured PaymentIntent and Charge, currency and amount. A live paid event atomically records the receipt, adds the pack to the paid credit ledger and marks the inbox event applied. Test evidence remains `test_paid_unapplied`. Refunds revoke the associated unused balance, including when reversal evidence arrives first. Disputes place a hold on the project's paid credits until resolution. A lost dispute revokes the affected pack's unused credits. [Checkout line items](https://docs.stripe.com/api/checkout/sessions/line_items).

An upgraded project has one spendable balance. Public HTTP uses the reviewed transfer tariff; scoped HTTP and Browser use their reviewed per-operation prices. The trial-only daily quota no longer applies, while route, destination, transfer, provider-budget and concurrency protections still apply. The original grant and purchase evidence stays in the ledger. A refund removes the affected pack's unused credits without undoing the conversion or removing signup credits; a dispute hold blocks spending until cleared. In-flight and uncertain trial work remains reserved or held, and a verified release returns those credits to the unified balance.

## Account API

The browser calls the existing trusted same-origin bridge. Each project request requires the owner session, and Checkout POST additionally requires session-bound CSRF.

- `GET /control/projects/:id/billing` exposes the configured `stripe` catalog, per-pack `can_purchase`, current pending checkout and recent purchase history. `paid_credits` exposes the prepaid balance and payment hold. For an upgraded project, billing and usage expose `credit_balance: {mode:'unified',unit:'credits',available,granted,used,reserved,held,revoked_unused,payment_hold}` and `paid_credits` mirrors that balance for existing clients. `credits` retains historical trial usage with no spendable amount after conversion.
- `POST /control/projects/:id/billing/stripe/checkout` accepts `{plan_id,idempotency_key}` with a lowercase UUID. Save the key before submitting. An open response includes a Stripe-hosted `checkout_url` in a no-store response.
- `GET /control/projects/:id/billing/stripe/checkout/:key` reads saved evidence without calling Stripe. A return to the website does not update payment state.

A retry within the one-hour recovery window uses the original order, encoded parameters, expiration and Stripe idempotency key. An existing creation snapshot must map exactly to the Worker's pinned origin and form before it can be retried. A different key cannot replace a pending or uncertain purchase. Existing live balances and webhook processing continue with `enabled: false` when the account credentials remain configured. Stripe may prune its idempotency keys after 24 hours. [Stripe API idempotency](https://docs.stripe.com/api/idempotent_requests).

## Operator reconciliation

Use the gateway's private configuration and matching database environment. Retry an already signed pending or ignored inbox event by its ID. The command retrieves canonical Stripe evidence and uses the same idempotent transaction as the normal processor.

```sh
node src/stripe-reconcile-cli.mjs --event evt_ID
```

For a lost create response beyond the recovery window, locate the existing Checkout in Stripe with its FetchX order reference and use its exact Session ID. This binds an independently verified Session to the existing order. A verified expired Session releases the pending capacity. A paid Session still needs the signed event in the inbox. An unknown outcome stays reserved.

```sh
node src/stripe-reconcile-cli.mjs --checkout-order ORDER_UUID SESSION_ID
```

## Verification and cutover

Set `controlPlane.unifiedCredits.enabled: true` only after testing the matching website and gateway together, reconciling open live checkouts, and verifying approved residential capacity for existing paid projects and the credits they can convert. Startup backfills existing verified, unreversed live purchases in an atomic transaction under the Stripe sales lock and rejects the activation if approved capacity is insufficient. New live Checkout orders reserve capacity for the pack and any trial credits that could join it. The flag defaults off. Turning it off stops new conversions; existing upgraded projects retain their unified balances. Keep a gateway version that recognizes unified reservations and grants once any conversion has occurred.

Run the local Worker and broker checks with synthetic keys and fake Stripe responses. The Wrangler dry run checks bundling and the rate bindings. The Worker pins compatibility date `2026-10-30` to match the installed workerd runtime used for local smoke verification.

```sh
node --test --test-concurrency=1 test/control-stripe-broker.test.mjs
WRANGLER_SEND_METRICS=false website/node_modules/.bin/wrangler deploy --dry-run --config payments-worker/wrangler.jsonc
```

Run PostgreSQL coverage serially against an explicitly disposable `gateway_test_*` database. The integration covers the brokered Checkout, the signed Worker relay and the real gateway inbox through the sandbox receipt projection.

```sh
TEST_DATABASE_URL=postgresql://127.0.0.1/gateway_test_fetchx_stripe_broker_20261104 \
  node --test --test-concurrency=1 test/control-stripe-broker.test.mjs test/control-stripe.test.mjs test/control-e2e.test.mjs test/control.test.mjs test/control-credits.test.mjs test/control-trial-grants.test.mjs
```

Before a live cutover, verify an actual Stripe sandbox Checkout, its signed relay and a durable `test_paid_unapplied` receipt. Confirm route and provider capacity for the released catalog. After the authorized live cutover is accepted, revoke any retired Stripe key previously held by the gateway and remove obsolete Stripe key files from the host. Keep webhook processing enabled during a sales pause by retaining the broker and its public relay verification keys.
