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
4. **Website.** Build and deploy `website/` to Pages after the platform, since the console needs the new API.

## Rollback

A release that changed no tables rolls back to the previous image. One that changed tables needs the pre-release backup restored into the database first, then the previous image; requests made in between are lost, and purchases made in between are re-applied from Stripe (`node src/stripe-reconcile-cli.mjs`).

## Incidents

- **Every fetch answers 503 `unavailable`:** the engine is down, unreachable on `fetchx-internal`, or refuses the service token. `operator.mjs status` shows which; the platform logs `engine_unavailable` with the cause.
- **Charges lag behind results:** events are not arriving. Check `overdue_settlements` in `operator.mjs status`, the engine's `events.undelivered`, and that both sides hold the same event key. The reconciler settles overdue jobs from the engine meanwhile.
- **A site that suddenly fails, browser or captcha problems:** these are engine incidents; see the engine's operations guide and the admin portal's site and rule pages.
- **A customer disputes a charge:** the request's `attempts` and `credits.charged` are in `GET /v1/fetch/{id}` for 90 days; correct the balance with `operator.mjs credits`.
