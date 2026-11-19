# Operations

## Running

Run exactly one gateway per database: it takes a PostgreSQL advisory lock at start and exits if it loses it. At start it creates or migrates every table (`Store.init`), loads provider rules, closes requests a previous process left running as `uncertain` (never resending them) and releases their credits, then serves on `GATEWAY_PORT` (8788). Every five minutes it deletes stored content older than 7 days and requests older than 90.

`GET /healthz` checks the process and the database. `node src/operator.mjs status` (inside the container) shows the last day's requests by status and captcha spend.

Secrets: keep `gateway.json`, the client token and database credentials out of Git, mode 0600, owned by UID 10001. Stored requests and results are sealed with `artifactKey`; back up the key with the database, or the backup cannot be read.

## Deploying a release

Deploy only from a tag on `main`, after the full test suite passes.

1. **Back up.** A `pg_dump` of the database, plus `gateway.json`. On porttrack this is `fetchx-backup.timer`; run it by hand before a release and check the archive.
2. **Build** the image from the tag and run the test suite inside it against a throwaway `gateway_test_*` database.
3. **Workers first.** Install the release's worker image and runtime pin on every pool worker (or let the autoscaler roll them), so their runtime matches the gateway's.
4. **Recreate the gateway** with every Compose file its container was created with (read the `com.docker.compose.project.config_files` label; the production gateway uses the base file plus the browser-pool overlay). Wait for `healthy` with no restarts; roll back to the previous image if it is not healthy within two minutes.
5. **Website.** Build and deploy `website/` to Pages after the gateway, since the console needs the new API.

## Upgrading from the releases before /v1

The first start of this release migrates the database in one transaction (`Store.migrateLegacy`): if anything fails, nothing changes and the old schema stays.

- Each project's balance becomes: its trial grant + its live purchases − every credit it spent under the old trial and paid ledgers (an opening `credit_adjustments` row). Credits held by uncertain old operations are released.
- Purchases keep their grants. USD-only checks become USD or INR; the trial copies the old unified-credit upgrade made (`source = 'signup_trial'`) are removed, because the trial is counted once from `control_credit_accounts`.
- The old tables (v1 workflows and jobs, v2 operations, sessions, artifacts and queues, the old credit ledgers, access profiles and overrides, route health, Scrape.do rules) are dropped. Users, projects, memberships, keys, sessions, Stripe records, provider rules, site knowledge and admin probes stay.

Rehearse it first: restore last night's backup into a throwaway database (`/usr/local/sbin/restore-test-fetchx` on porttrack), run the new image's `Store.init()` against it, and compare every project's balance before and after.

Configuration changes for the same release:

- `browser.camoufox` = `{version, sha256, executablePath, modelDir}` and `browser.pool` = `{registry_path, callback_socket}` (they were under `v2`).
- `captcha` keeps its keys; add `datadome: true` only after deciding to send proxy credentials to 2Captcha.
- Remove `v2`, `sourceProfiles`, `jobs`, `scrapedo`, `defaultRouting`, `controlPlane.projectTemplate`, `controlPlane.playground`, `controlPlane.paidCreditPolicy` and `controlPlane.unifiedCredits`; they are ignored.
- Optional: `pricing`, `dns`, `fetchLimits` ([configuration](configuration.md)).

Old API keys keep working: their `fetch:read`, `fetch:write` and `usage:read` scopes apply to `/v1`, and `profiles:read` is simply unused. Callers of `/v2/*` and the old `/v1/workflows` get 404.

## Rollback

Before the first start of the new release, rollback is just the previous image. After it, the old tables are gone: restore the pre-release backup into the database, then start the previous image. Requests made in between are lost; purchases made in between must be re-applied from Stripe (`node src/stripe-reconcile-cli.mjs`).

## Incidents

- **A site that suddenly fails:** check the admin portal's Site knowledge tab. Forget the host to let auto mode relearn it, or add a provider rule if a provider refuses it.
- **Browser steps failing everywhere:** check the runtime pin (`browser_build_mismatch`), worker health in `/v1/pool-metrics` on the callback socket, and the autoscaler's status.
- **Captcha spend:** `operator.mjs status`; lower `captcha.maxDailyMicroUsd` to stop solving without a restart of anything else.
- **A customer disputes a charge:** the request's `attempts` and `credits.charged` are in `GET /v1/fetch/{id}` for 90 days; correct the balance with `operator.mjs credits`.
