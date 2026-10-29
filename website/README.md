# FetchX marketing website

An isolated Astro static website with Cloudflare Pages Functions for qualified pilot enquiries. It does not call or deploy the crawling gateway. The selected dark presentation uses self-hosted fonts, original vector illustrations, controlled animation and fictional sample records.

## Local development and verification

Node 24 is supported. Run from `website/`:

```sh
npm ci
npm run dev
npm run check
npm test
npm run build
```

The development site is at `http://127.0.0.1:4327`. Astro 7 runs it in the background; use `npx astro dev status` / `npx astro dev stop` to manage it. Run a static preview with `npx astro preview --host 127.0.0.1 --port 4329` before:

```sh
node tests/ui/site-check.mjs
node tests/ui/form-check.mjs
```

Set `TEST_BASE_URL` and `TEST_OUTPUT_DIR` to override the browser scripts' local URL and report directory. The form checks inject synthetic verification and API fixtures only in the test browser. No production handler has a test bypass. Vitest uses an ephemeral local Workers runtime and D1 database, blocks unexpected network calls, and tests validation, bot rejection, deduplication, races, storage failure, mail failure, retries and expiry. No paid providers are used.

Seven marketing pages are `/`, `/samples`, `/pricing`, `/pilot`, `/developers`, `/privacy`, `/terms`; `/404.html` handles missing pages. Samples have matching table, JSON and CSV records and never make provider requests. The developer endpoint is explicitly a provisioned placeholder.

## Hosting and settings

Cloudflare Pages project: `fetchx-marketing`, in the personal account identified in `wrangler.jsonc`. Production branch: `main`. Preview branch: `staging`.

- Intended public domain: `https://fetch.headrun.ai`.
- Stable preview: `https://staging.fetchx-marketing.pages.dev`.
- Production and preview have separate private D1 databases.
- `wrangler.jsonc` contains public resource identifiers and non-secret settings only.
- `functions/api/pilot.ts` handles `POST /api/pilot`; `_routes.json` limits Function execution to `/api/*`.

Build variables:

| Variable | Preview | Production |
| --- | --- | --- |
| `PUBLIC_SITE_ENV` | `preview` | `production` |
| `PUBLIC_TURNSTILE_SITEKEY` | Real preview widget site key | Real production widget site key |

Cloudflare Pages **secrets**, configured separately in each deployment environment:

- `TURNSTILE_SECRET`: corresponding widget secret.
- `RESEND_API_KEY`: sending key scoped to the verified sender domain.
- `HASH_SECRET`: random, stable HMAC key for deduplication and rate-limit hashes. Do not rotate casually while enquiries remain in the database.

Runtime variables: `SITE_ENV`, `ALLOWED_ORIGINS`, `TURNSTILE_HOSTNAMES`, `MAIL_FROM`, `SALES_EMAIL`; these are in Wrangler. Turnstile must return action `pilot` and the exact submitted host. Staging accepts only the stable staging hostname, not arbitrary deployment URLs. Production accepts only `fetch.headrun.ai`.

Notifications go to `sales@headrun.ai`, from `FetchX <enquiries@notify.headrun.ai>`, with the visitor's address in Reply-To. Verify the sales mailbox and Resend sender before opening intake. Root-domain Google mail records must remain unchanged.

An absent site key leaves the form disabled. Missing server secrets fail closed. `PUBLIC_SITE_ENV` defaults to preview: previews emit noindex metadata and disallow robots, and all Pages-hosted domains additionally receive an `X-Robots-Tag` noindex header. Only the intended custom-domain production build is indexable.

## Intake and failure handling

1. Validate method, origin, JSON type, 16 KiB body limit and all field limits. No submitted URL is fetched, and credentials in URLs are rejected.
2. Validate Turnstile server-side, including hostname and action.
3. Use a request UUID and keyed same-day data hash to deduplicate. Changed data under an existing UUID returns a conflict. Ten new requests per hashed IP/hour are allowed.
4. Persist the private enquiry, privacy version, reference and 90-day expiry before returning confirmation.
5. Send a background Resend notification. Failed or uncertain delivery remains recorded; the visitor keeps the successful enquiry reference and does not need to resubmit.

Notifications use an atomic sender lease, a stable Resend idempotency key, and a stored immutable message body. Automatic/operator retries reuse the same message and key. They stop 23 hours after the first actual send attempt, safely inside Resend's 24-hour deduplication window. A configuration failure before sending does not start that window.

Application logs contain event names and enquiry references, not form fields, tokens, secrets or raw IP addresses. No public admin, database-read or scraping endpoint exists.

## Private operator commands

The local tool uses the current Wrangler OAuth login (macOS or Linux), or a `CLOUDFLARE_API_TOKEN` supplied through the environment. It restricts operations to the selected FetchX database. It never prints credentials or enquiry payloads.

```sh
node ops/enquiries.mjs status preview
node ops/enquiries.mjs status production
node ops/enquiries.mjs purge production         # dry-run counts
node ops/enquiries.mjs purge production --apply # expired records only
node ops/enquiries.mjs retry production FX-EXACT-ENQUIRY-UUID
```

For retry, load `RESEND_API_KEY` into the process environment using your secure secret store or a silent prompt; never place a secret in a command argument, source file or shell history. The reference must be a real full reference. A skipped retry means already sent, an active sender lease, an expired record, or an elapsed retry window. After that window, reconcile the original reference in Resend and the sales inbox before making a separately reviewed manual contact. Do not blindly replay an uncertain send with a fresh key.

Review pending/failed/uncertain notifications through `status`. A provider acceptance (`sent`) is not proof of inbox delivery: the launch test must independently confirm the same reference in the sales inbox.

## Retention

`ops/retention-worker.ts`, configured in `wrangler.retention.jsonc`, runs daily at **02:15 UTC (07:45 IST)**. It deletes expired enquiries and short-lived hashed rate buckets in both databases. It has no public URL. Enquiries expire after 90 days; rate buckets expire after 24 hours, with deletion on the next daily sweep.

```sh
npx wrangler deploy --config wrangler.retention.jsonc
```

The operator must also remove corresponding enquiry notifications from the sales mailbox at 90 days unless they form part of an active engagement. Enquiry deletion requests require verification of the requester, removal of the matching D1 row and matching sales notifications, and recording completion without retaining the deleted payload. Provider backup/log retention is governed by those providers. Do not export enquiries into Git or public reports.

## Deploy and launch

For D1 commands, explicitly set `CLOUDFLARE_ACCOUNT_ID` to the account in Wrangler if the CLI cannot resolve a multi-account login. Apply migrations to the matching environment:

```sh
npx wrangler d1 migrations apply fetchx-enquiries-preview --remote --env preview
npx wrangler d1 migrations apply fetchx-enquiries --remote --env production
PUBLIC_SITE_ENV=preview npm run build
npx wrangler pages deploy dist --project-name fetchx-marketing --branch staging
```

The Pages project already exists. Do not create a replacement project via a CLI migration to Workers. Keep the approved Pages/external-DNS architecture.

After preview review, real Turnstile configuration, verified Resend sender and sales mailbox, build with `PUBLIC_SITE_ENV=production` and the production site key, then deploy with `--branch main`. Use Pages secrets for private runtime values. Public site keys are intentionally embedded in the client build.

Associate `fetch.headrun.ai` in Pages before adding its GoDaddy `fetch` CNAME to the exact Pages target returned by Cloudflare (`fetchx-marketing.pages.dev` for this project). Do not move nameservers or alter Parse/root-domain records. Add only the isolated `notify.headrun.ai` sender verification records supplied by Resend.

Verify HTTPS, apex/trailing-slash redirects, canonical URLs, robots and sitemap. Submit one clearly labelled real launch enquiry, confirm its reference in private D1 and the verified sales inbox, then reconcile the test record. Confirm production cannot accept requests from other origins or missing verification.

Keep the successful deployment ID and tested source commit in a launch receipt. Pages retains deployments: roll back to the last verified production deployment in the dashboard/API. For the first release, retain a closed, non-indexed build to redeploy if intake must be withdrawn. Rollback must preserve D1 records and notification history; never roll back by deleting databases. See Cloudflare's [custom-domain guide](https://developers.cloudflare.com/pages/configuration/custom-domains/) and [rollback guide](https://developers.cloudflare.com/pages/configuration/rollbacks/).
