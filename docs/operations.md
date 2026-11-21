# Operations

## Running

The platform and the engine run as separate Compose projects, each with its own database, joined by the external Docker network `fetchx-internal` (create it once with `docker network create fetchx-internal`). The platform reaches the engine as `http://engine:8790`; the engine sends events to `http://platform-events:8789/internal/engine-events`. Neither of those ports is published to the host. Start the engine first; without it fetches answer 503 `unavailable` and everything else keeps working.

Run exactly one platform per database: it takes a PostgreSQL advisory lock at start and exits if it loses it. At start it creates any missing table (`Store.init`), then serves the public app on `PLATFORM_PORT` (8788) and the events listener on `PLATFORM_EVENTS_PORT` (8789). Every 30 seconds the reconciler looks up jobs still pending 30 seconds past their deadline: finished ones are settled from the engine, ones the engine never started are released. Every hour it deletes settlement rows older than 90 days; the engine deletes stored content after 7 days and job metadata after 90 on its own.

`GET /healthz` checks the process and the database. `node src/operator.mjs status` (inside the container) shows the engine's release and status, the last day's settled requests, settlements overdue for an event, and queued or abandoned webhooks.

Secrets: keep `platform.json`, the client token and database credentials out of Git, mode 0600, owned by UID 10001. Webhook secrets and queued webhook URLs are sealed with `sealingKey`; back up the key with the database, or the backup cannot be read.

## Staging on the same host

A second platform and engine can run next to production with their own Compose project names, databases and private network. Put these in each side's env file, next to the usual values: `FETCHX_IMAGE_TAG=staging`, `FETCHX_PORT=18788` and `FETCHX_INTERNAL_NETWORK=fetchx-staging-internal` for the platform, and `FETCHX_ENGINE_IMAGE_TAG=staging` and `FETCHX_INTERNAL_NETWORK=fetchx-staging-internal` for the engine. Then run `docker compose -p fetchx-staging …` and `docker compose -p fetchx-engine-staging …`. The image tags keep a staging build from replacing the image production runs.

## Deploying a release

Deploy only from a tag on `main` (platform tags are `release-YYYYMMDD-<sha>`, engine tags `engine-YYYYMMDD-<sha>`), after the full test suite passes. The two deploy independently while the contract version stays the same; a contract change ships in the engine first, accepting both versions, then in the platform.

1. **Back up.** A `pg_dump` of the database, plus `platform.json`. On porttrack this is `fetchx-backup.timer`; run it by hand before a release and check the archive.
2. **Build** the image from the tag and run the test suite inside it against a throwaway `gateway_test_*` database.
3. **Recreate the platform** (`docker compose up -d gateway`). Wait for `healthy` with no restarts; roll back to the previous image if it is not healthy within two minutes. Jobs that finish while it restarts are not lost: the engine retries their events, and the reconciler settles any it gives up on.
4. **Website.** Build and deploy `website/` to Pages after the platform, since the console needs the new API. Apply new `website/migrations` to both D1 databases first, and redeploy `wrangler.retention.jsonc` when `website/ops/` changed (on porttrack: `fx-cloudflare d1-migrate <tag> preview|production`, then `fx-cloudflare retention-worker <tag>`).

## Rollback

A release that changed no tables rolls back to the previous image. One that changed tables needs the pre-release backup restored into the database first, then the previous image; requests made in between are lost, and purchases made in between are re-applied from Stripe (`node src/stripe-reconcile-cli.mjs`).

## Status page and maintenance

The status page at https://fetchx.ai/status does not run on porttrack. A Cloudflare cron (the `fetchx-enquiry-retention` Worker, `website/ops/retention-worker.ts`, every minute) reads `GET https://app.fetchx.ai/v1/status` with a 10 s timeout and records it in the website's D1 database (`website/migrations/0003_status.sql`): a row per check for 7 days, a row per day for 90, outages it saw itself, and the notices. The page reads them through `/api/status`. One unanswered check is a blip; two in a row is shown as an outage, unless an active maintenance notice explains it. No check for five minutes shows "unknown". The monitor's own failures are in the Worker's logs (`status_check` events).

When the gateway itself is down (a restart, a crash), host nginx answers `503` with the API's error shape, code `unavailable` and `Retry-After: 30`, instead of its HTML 502 page: [`ops/nginx/fetchx-api-unavailable.conf`](../ops/nginx/fetchx-api-unavailable.conf), installed as `/etc/nginx/snippets/fetchx-api-unavailable.conf` and included in the `app.fetchx.ai` server block. Install it with `sudo install -m 644 ops/nginx/fetchx-api-unavailable.conf /etc/nginx/snippets/`, add the `include` line, then `sudo nginx -t && sudo systemctl reload nginx`. Reloading does not drop connections.

Planned maintenance:

1. At least a day ahead, post a maintenance notice in the admin portal's Status tab with its start, planned end, the components it touches and, if requests must stop, **Pause the API**. It shows on the status page as scheduled.
2. At the start time the pause takes effect by itself: every `/v1` route except `GET /v1/status` answers `503 maintenance` with `Retry-After` until the planned end (30 s to an hour). Requests already running finish. Add updates as you go; they show with their time.
3. Do the work. While the gateway restarts, nginx answers `503 unavailable`, and the status page keeps showing maintenance rather than an outage until 10 minutes past the planned end.
4. Resolve the notice. That ends the pause at once.

Incidents: post an incident notice with its impact (`minor` shows degraded, `major` an outage) and the components affected, add updates, and resolve it when it is over. Resolved notices stay on the status page for 90 days.

## Incidents

- **Every call answers 503 `maintenance`:** a maintenance notice that pauses the API is active. Resolve it in the admin portal's Status tab, or wait for its planned end.
- **Every fetch answers 503 `unavailable`:** the engine is down, unreachable on `fetchx-internal`, or refuses the service token. `operator.mjs status` shows which; the platform logs `engine_unavailable` with the cause.
- **Charges lag behind results:** events are not arriving. Check `overdue_settlements` in `operator.mjs status`, the engine's `events.undelivered`, and that both sides hold the same event key. The reconciler settles overdue jobs from the engine meanwhile.
- **A site that suddenly fails, browser or captcha problems:** these are engine incidents; see the engine's operations guide and the admin portal's site and rule pages.
- **Captcha, proxy or VM spend, or one customer using too much:** the admin portal's Budgets tab shows every budget, the engine's and the platform's, and how much of each is used. Changes apply at once, without a restart. See [budgets](budgets.md).
- **A customer disputes a charge:** the request's `attempts` and `credits.charged` are in `GET /v1/fetch/{id}` for 90 days; correct the balance with `operator.mjs credits`.
