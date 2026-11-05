# FetchX marketing website

An Astro website for the FetchX web scraping and unblocking API. The graphite, lime and cyan design uses self-hosted fonts and original execution diagrams. The account workspace connects to the FetchX gateway through a same-origin Pages Function; technical enquiries retain their separate intake handler.

This remains a **non-indexed review build**. Signup, projects, scoped API keys, native HTTP requests and usage use the configured backend. An unavailable backend produces an explicit unavailable state, never simulated account activity. Credit pricing and checkout follow the configured payment catalog; the intelligence layer remains a proposal. See [self-service setup](../docs/self-service-backend.md) and [the launch backlog](../docs/website-redesign.md).

## Country-selected credit pricing

`GET /api/pricing` returns INR/UPI offers when Cloudflare's trusted `request.cf.country` is `IN`, and USD/card offers for other or unknown countries. Browser country headers, language, timezone and query parameters do not select a market. The public response is private/no-store at the browser and CDN. Static pricing markup contains currency-neutral placeholders until this response is verified; a failed request leaves pricing unavailable rather than displaying a guessed currency. JavaScript is required for local prices and checkout.

INR packs are ₹175 / 10,000 credits, ₹750 / 50,000, ₹1,800 / 150,000 and ₹9,000 / 1,000,000. Their unit discounts are 14.3%, 31.4% and 48.6% relative to the entry pack. Existing USD packs retain their prices. Free trial eligibility and the shared credit balance do not change with currency.

The private control bridge derives `X-FetchX-Client-Country` from the same Cloudflare metadata. Billing requires a single `stripe.currency` catalog, formats prices in actual minor units, and offers an explicit unavailable state if INR sales are paused or not configured. A reviewed INR catalog can remain visible with purchase actions disabled while a saved checkout is recovered. A saved checkout retains its original currency and operation key across country changes. Historical purchases show their original billed currency. Backend price, market and payment validation remains authoritative.

`tests/pricing.test.ts`, the country-spoof cases in `tests/control-proxy.test.ts`, and `tests/ui/inr-pricing-check.mjs` cover country selection, exact prices/discounts, cache isolation, no currency flash, UPI pending/failure/success, unavailable markets and saved checkout recovery. These checks use synthetic fixtures and do not create real payments.

## Local development and verification

Node 24 is supported. Run from `website/`:

```sh
npm ci
npm run dev
npm run check
npm test
npm run build
```

The development site is at `http://127.0.0.1:4327`. Astro 7 runs it in the background; use `npx astro dev status` / `npx astro dev stop` to manage it. `npm run test:browser` starts an isolated local Pages server and runs site, documentation, product-journey, Google/GitHub sign-in and enquiry checks. To inspect manually, use `npm run pages:dev` at `http://127.0.0.1:4328` before:

```sh
node tests/ui/site-check.mjs
node tests/ui/docs-check.mjs
node tests/ui/product-check.mjs
node tests/ui/stripe-check.mjs
node tests/ui/inr-pricing-check.mjs
node tests/ui/google-check.mjs
node tests/ui/github-check.mjs
node tests/ui/form-check.mjs
```

Set `TEST_BASE_URL` and `TEST_OUTPUT_DIR` to override the browser scripts' local URL and report directory. The form checks inject synthetic verification and API fixtures only in the test browser. No production handler has a test bypass. Vitest uses an ephemeral local Workers runtime and D1 database, blocks unexpected network calls, and tests validation, bot rejection, deduplication, races, storage failure, mail failure, retries and expiry. No paid providers are used.

With a built preview running, `TEST_BASE_URL=http://127.0.0.1:4331 node ops/performance-check.mjs` audits the homepage, API product page and resources with mobile Lighthouse. It writes local JSON reports and fails if performance falls below 90. Run it without competing browser checks for consistent lab measurements; production field measurements remain a launch task.

The marketing site includes the homepage, four `/products/*` pages, three `/use-cases/*` pages, four `/guides/*` articles, `/resources`, `/developers`, `/pricing`, `/about` and `/contact`. Existing `/samples`, `/pilot`, `/privacy` and `/terms` routes remain available. Product and guide content is maintained in `src/data/marketing-content.ts`; `site-pages.ts` drives the sitemap and `/llms.txt`.

The eight API quickstart/reference pages retain their `/docs` URLs and share `src/data/api-docs.ts`. Markdown exports at `/docs/quickstart.md` and `/docs/<slug>.md` are generated from the same content. Examples require a configured gateway and approved profile. `/404.html` handles missing pages.

The product journey starts at `/signup` or `/login` and continues to `/app`, `/app/onboarding`, `/app/playground`, `/app/requests`, `/app/keys` and `/app/billing`. Configured GitHub, Google and email sign-in create an HttpOnly session. Only the selected project ID and pending operation keys enter session storage; credentials and source inputs do not. Recovery reads retained gateway state with GET and never dispatches source work. Billing shows authoritative allocations, holds, purchase history and one-time hosted Stripe Checkout when enabled. Automatic upgrades and refills are not offered.

GitHub sign-in appears only when `/api/control/status` advertises `github.enabled`. It uses a dedicated gateway OAuth application with only `user:email`, PKCE and the exact callback `https://fetchx.ai/api/control/auth/github/callback`. Its client secret and provider tokens stay in the gateway. The Pages callback is the sole cross-site GET exception: it validates bounded query parameters, forwards private JSON through the existing bridge, obtains the current session CSRF for explicit linking, clears the short-lived HttpOnly binding, and returns a fixed no-store, no-referrer redirect. It never renders provider descriptions or identity tokens. An existing FetchX email requires signing in through the existing method and choosing **Connect GitHub** in the signed-in account panel. Linking preserves the account's projects and credentials. Disabled GitHub leaves Google and email available. `tests/github-proxy.test.ts` and `tests/ui/github-check.mjs` use synthetic fixtures only; browser fixtures do not establish a live GitHub authorization or production configuration.

`functions/api/control/[[path]].ts` requires runtime `FETCHX_CONTROL_URL`, secret `FETCHX_CONTROL_SECRET` (the gateway's bridge secret), and the exact website origin in `ALLOWED_ORIGINS`. The remote gateway must use HTTPS. Explicit loopback review additionally requires `SITE_ENV=development` and `FETCHX_CONTROL_ALLOW_LOOPBACK=true`. Never expose these values through `PUBLIC_*` variables. Astro's static/dev server alone cannot run the account proxy; use Pages locally. The protected local review runner and full configuration are documented in [self-service setup](../docs/self-service-backend.md).

## Hosting and settings

Cloudflare Pages project: `fetchx-marketing`, in the personal account identified in `wrangler.retention.jsonc`. Production branch: `main`. Preview branch: `staging`.

- Intended public domain: `https://fetchx.ai`.
- Stable preview: `https://staging.fetchx-marketing.pages.dev`.
- Production and preview have separate private D1 databases.
- `wrangler.jsonc` contains public resource identifiers and non-secret settings only.
- `functions/api/pilot.ts` handles `POST /api/pilot`; `_routes.json` limits Function execution to `/api/*`.

Build variables:

| Variable | Preview | Production |
| --- | --- | --- |
| `PUBLIC_SITE_ENV` | `preview` | `production` |
| `PUBLIC_PRODUCT_LAUNCH_READY` | `false` | `true` only after approved launch gates |
| `PUBLIC_TURNSTILE_SITEKEY` | Real preview widget site key | Real production widget site key |

Cloudflare Pages **secrets**, configured separately in each deployment environment:

- `TURNSTILE_SECRET`: corresponding widget secret.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`: an OAuth client and offline Gmail send authorization for the FetchX mailbox, or an account explicitly authorized to send as `hello@fetchx.ai`.
- `HASH_SECRET`: random, stable HMAC key for deduplication and rate-limit hashes. Do not rotate casually while enquiries remain in the database.

Runtime variables: `SITE_ENV`, `ALLOWED_ORIGINS`, `TURNSTILE_HOSTNAMES`, `MAIL_FROM`, `SALES_EMAIL`; these are in Wrangler. Turnstile must return action `pilot` and the exact submitted host. Staging accepts only the stable staging hostname, not arbitrary deployment URLs. Production accepts only `fetchx.ai`.

Notifications go to `hello@fetchx.ai`, from `FetchX <hello@fetchx.ai>`, with the visitor's address in Reply-To. Verify the sales mailbox and Gmail sender authorization before opening intake. Root-domain Google mail records must remain unchanged.

An absent site key leaves the enquiry form disabled. Missing server secrets fail closed. Indexing requires both `PUBLIC_SITE_ENV=production` and `PUBLIC_PRODUCT_LAUNCH_READY=true`. Otherwise pages emit noindex metadata and robots disallow crawling. All Pages-hosted domains additionally receive an `X-Robots-Tag` noindex header. Signup and workspace pages stay non-indexed even in a launch build. Confirm actual hosting crawler controls separately before publication.

## Intake and failure handling

1. Validate method, origin, JSON type, 16 KiB body limit and all field limits. No submitted URL is fetched, and credentials in URLs are rejected.
2. Validate Turnstile server-side, including hostname and action.
3. Use a request UUID and keyed same-day data hash to deduplicate. Changed data under an existing UUID returns a conflict. Ten new requests per hashed IP/hour are allowed.
4. Persist the private enquiry, privacy version, reference and 90-day expiry before returning confirmation.
5. Send a background Gmail notification. Failed or uncertain delivery remains recorded; the visitor keeps the successful enquiry reference and does not need to resubmit.

Notifications use an atomic sender lease, a stable Message-ID and a stored immutable message body. Gmail does not provide an idempotency key for sends: uncertain or interrupted sends are held for manual reconciliation and never replayed automatically. Confirmed rejections may be retried.

Intake application logs contain event names and enquiry references, not form fields, tokens, secrets or raw IP addresses. Account API access is separately authenticated and project-scoped; the website exposes no anonymous fetch or database-read endpoint.

## Private operator commands

The local tool uses the current Wrangler OAuth login (macOS or Linux), or a `CLOUDFLARE_API_TOKEN` supplied through the environment. It restricts operations to the selected FetchX database. It never prints credentials or enquiry payloads.

```sh
node ops/enquiries.mjs status preview
node ops/enquiries.mjs status production
node ops/enquiries.mjs purge production         # dry-run counts
node ops/enquiries.mjs purge production --apply # expired records only
node ops/enquiries.mjs retry production FX-EXACT-ENQUIRY-UUID
```

For retry, load `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` into the process environment using your secure secret store or a silent prompt; never place a secret in a command argument, source file or shell history. The reference must be a real full reference. A skipped retry means already sent, an active sender lease, an expired record, or an uncertain/interrupted send. Reconcile the reference in the Gmail Sent folder and the sales inbox before a separately reviewed manual contact. Do not blindly replay an uncertain send.

Review pending/failed/uncertain notifications through `status`. A provider acceptance (`sent`) is not proof of inbox delivery: the launch test must independently confirm the same reference in the sales inbox.

## Retention

`ops/retention-worker.ts`, configured in `wrangler.retention.jsonc`, runs daily at **02:15 UTC (07:45 IST)**. It deletes expired enquiries and short-lived hashed rate buckets in both databases. It has no public URL. Enquiries expire after 90 days; rate buckets expire after 24 hours, with deletion on the next daily sweep.

```sh
npx wrangler deploy --config wrangler.retention.jsonc
```

The operator must also remove corresponding enquiry notifications from the sales mailbox at 90 days unless they form part of an active engagement. Enquiry deletion requests require verification of the requester, removal of the matching D1 row and matching sales notifications, and recording completion without retaining the deleted payload. Provider backup/log retention is governed by those providers. Do not export enquiries into Git or public reports.

## Deploy and launch

Pages configuration does not accept `account_id`. For Pages and D1 commands, explicitly set the public account identifier for the multi-account login. Apply migrations to the matching environment:

```sh
export CLOUDFLARE_ACCOUNT_ID=9ecc416f47f6a620665eb552ae29df2b
npx wrangler d1 migrations apply fetchx-enquiries-preview --remote --env preview
npx wrangler d1 migrations apply fetchx-enquiries --remote --env production
PUBLIC_SITE_ENV=preview npm run build
npx wrangler pages deploy dist --project-name fetchx-marketing --branch staging
```

The Pages project already exists. Do not create a replacement project via a CLI migration to Workers. Keep the approved Pages/external-DNS architecture.

Public launch additionally requires working self-service signup, verified advertised capabilities, approved commercial terms and all P0 checks in the launch backlog. Only then build with `PUBLIC_SITE_ENV=production`, `PUBLIC_PRODUCT_LAUNCH_READY=true` and the production site key, and deploy with `--branch main` under release authorization. Keep the launch flag false for design review. Use Pages secrets for private runtime values. Public site keys are intentionally embedded in the client build.

Associate `fetchx.ai` in Pages and configure the apex DNS record in its Cloudflare zone using the exact target returned by Cloudflare. Preserve existing records and unrelated domains.

Verify HTTPS, apex/trailing-slash redirects, canonical URLs, robots and sitemap. Submit one clearly labelled real launch enquiry, confirm its reference in private D1 and the verified sales inbox, then reconcile the test record. Confirm production cannot accept requests from other origins or missing verification.

Keep the successful deployment ID and tested source commit in a launch receipt. Pages retains deployments: roll back to the last verified production deployment in the dashboard/API. For the first release, retain a closed, non-indexed build to redeploy if intake must be withdrawn. Rollback must preserve D1 records and notification history; never roll back by deleting databases. See Cloudflare's [custom-domain guide](https://developers.cloudflare.com/pages/configuration/custom-domains/) and [rollback guide](https://developers.cloudflare.com/pages/configuration/rollbacks/).
