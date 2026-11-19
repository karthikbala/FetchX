# Operations

## Running

Run exactly one gateway per database: it takes a PostgreSQL advisory lock at start and exits if it loses it. At start it creates any missing table (`Store.init`), loads provider rules, closes requests a previous process left running as `uncertain` (never resending them) and releases their credits, then serves on `GATEWAY_PORT` (8788). Every five minutes it deletes stored content older than 7 days and requests older than 90.

`GET /healthz` checks the process and the database. `node src/operator.mjs status` (inside the container) shows the last day's requests by status and captcha spend.

Secrets: keep `gateway.json`, the client token and database credentials out of Git, mode 0600, owned by UID 10001. Stored requests and results are sealed with `artifactKey`; back up the key with the database, or the backup cannot be read.

## Deploying a release

Deploy only from a tag on `main`, after the full test suite passes.

1. **Back up.** A `pg_dump` of the database, plus `gateway.json`. On porttrack this is `fetchx-backup.timer`; run it by hand before a release and check the archive.
2. **Build** the image from the tag and run the test suite inside it against a throwaway `gateway_test_*` database.
3. **Workers first.** Install the release's worker image and runtime pin on every pool worker (or let the autoscaler roll them), so their runtime matches the gateway's.
4. **Recreate the gateway** with every Compose file its container was created with (read the `com.docker.compose.project.config_files` label; the production gateway uses the base file plus the browser-pool overlay). Wait for `healthy` with no restarts; roll back to the previous image if it is not healthy within two minutes.
5. **Website.** Build and deploy `website/` to Pages after the gateway, since the console needs the new API.

## Checking the browser path against a live site

`scripts/browser-live-check.mjs` runs the real browser path (pinned Camoufox, capture, warm-up, self-clear wait, exit-IP placement, kept identity) through one residential session against live URLs, without the gateway, and prints one JSON line per page. Use it to qualify a release's browser and to see how a protected site answers before and after a change; the header of the script has the `docker run` line. It spends residential bandwidth but no customer credits, and does not touch site knowledge or cooldowns. `--fonts` adds one line per draw listing the fonts a page can detect: only the `windows` list may be non-empty. Each page has a hard limit of 150 s; still run it under `timeout` with a named container, and remove the container afterwards, because a timeout stops only the docker client.

## Rollback

A release that changed no tables rolls back to the previous image. One that changed tables needs the pre-release backup restored into the database first, then the previous image; requests made in between are lost, and purchases made in between are re-applied from Stripe (`node src/stripe-reconcile-cli.mjs`).

## Incidents

- **A site that suddenly fails:** check the admin portal's Site knowledge tab. Forget the host to let auto mode relearn it, or add a provider rule if a provider refuses it.
- **Browser steps failing everywhere:** check the runtime pin (`browser_build_mismatch`), worker health in `/v1/pool-metrics` on the callback socket, and the autoscaler's status.
- **Captcha, proxy or VM spend:** the admin portal's Budgets tab shows each budget and how much of it is used; set the 24-hour captcha budget to 0 to stop solving, or cap a residential provider, at once and without a restart. See [budgets](budgets.md).
- **A customer disputes a charge:** the request's `attempts` and `credits.charged` are in `GET /v1/fetch/{id}` for 90 days; correct the balance with `operator.mjs credits`.
