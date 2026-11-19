# Moving production to the platform and the engine

A one-time runbook for replacing the single gateway with the platform (this repository) and the engine (fetchx-engine). The platform keeps the gateway's database and its accounts, credits and purchases; the engine gets a new database with the fetch history, provider rules, site knowledge, captcha spend and probes. `scripts/split-migrate.mjs` moves the data. Cutting production over needs Karthik's go-ahead.

## Configuration

Split the gateway's `gateway.json` in two.

| Gateway key | Goes to |
| --- | --- |
| `artifactKey` | The engine, unchanged: stored requests and results stay sealed with it. |
| `proxies`, `residential`, `routes`, `dns`, `providerRules`, `providerRulesRefreshMs`, `siteKnowledge`, `browser`, `captcha`, `registry`, `callback` | The engine. |
| `fetchLimits` | Both: the engine keeps the body, wire, wait and retention limits; the platform keeps `maxCredits`, `maxConcurrentPerProject` and `metadataDays`. |
| `destinations` | Both: the engine for fetches, the platform for customer webhooks. |
| `projects` | The platform (tokens). Per-project `maxDailyCaptchaMicroUsd` goes to the engine's `projects`. |
| `release`, `controlPlane`, `pricing`, `admin` | The platform. `admin.maxProbesPerDay`, if set, goes to the engine. |

New values: the engine's `scripts/init-config.mjs` makes a service token and an event key (`platform-link.json`). The engine keeps the token's SHA-256 in `platform.tokenHashes`, the event key in `platform.eventKey`, and `platform.eventsUrl` = `http://platform-events:8789/internal/engine-events`. The platform keeps them in `engine.serviceToken` and `engine.eventKey`, and gets a new `sealingKey` (`openssl rand -hex 32`).

## Cutover

1. **Tags.** Both repositories tagged on `main`, both suites green.
2. **Back up.** Run the backup by hand (`systemctl start fetchx-backup.service`) and check the archive. Keep a copy of `gateway.json`.
3. **Network and engine database.** `docker network create fetchx-internal`. Start the engine's database and the engine once so that its tables exist, check `healthy`, then stop the engine (its database stays up). Nothing calls it yet.
4. **Stop the gateway.** It drains running requests (up to 240 s). Requests it could not finish stay pending and are closed by the engine in step 6.
5. **Move the data.** Run the script from the platform image in a one-off container joined to both databases' networks, with the tag's `scripts/` and both configurations mounted read-only. Both databases are called `db` in their own Compose project, so address them by container name:

   ```sh
   docker create --name fetchx-split --network <platform project>_default \
     -e DATABASE_URL=postgresql://fetchx:…@<platform db container>/fetchx \
     -e ENGINE_DATABASE_URL=postgresql://fetchx_engine:…@<engine db container>/fetchx_engine \
     -e PLATFORM_CONFIG=/run/split/platform.json \
     -v "$PWD/scripts:/app/scripts:ro" -v …/platform.json:/run/split/platform.json:ro -v …/gateway.json:/run/split/gateway.json:ro \
     fetchx:<tag> node scripts/split-migrate.mjs --old-config /run/split/gateway.json   # counts only
   docker network connect fetchx-engine_default fetchx-split
   docker start -a fetchx-split && docker rm fetchx-split
   ```

   Then the same with `--apply` at the end. Check its report: every engine table's `engine` count equals `source`, `settlements` equals `requests`, and `charged_in_settlements` equals `charged_in_ledger`. It can be run again safely.
6. **Start the engine, then the platform** with this repository's `compose.yaml` (and the engine's production overlay for its browser pool). The engine closes the left-over pending requests as `uncertain` and reports them; the platform releases their credits.
7. **Check.** `/healthz` on both, `operator.mjs status` on both (engine reachable, no overdue settlements, no undelivered events), an old request reads the same through `GET /v1/fetch/{id}`, the console signs in and shows history and balance, the admin portal lists rules and sites, and the live acceptance sites pass (Cuyahoga, the 25-page Expedia crawl, a captcha site).
8. **Website.** Deploy `website/` if the release changed it.

## Rollback

Stop the platform and the engine and start the previous gateway image with its old Compose files and `gateway.json`. Its tables were not changed, except webhook secrets, which were re-sealed; restore them first:

```sql
UPDATE webhook_secrets w SET secret = s.secret FROM split_gateway_webhook_secrets s WHERE w.project = s.project;
```

Charges made after the cutover are already in the shared ledger. Fetch history from after the cutover stays in the engine's database and is not shown by the gateway. Secrets rotated after the cutover go back to their earlier value.

## Afterwards

Once the engine has run for a week without a rollback, drop the gateway's copies from the platform database:

```sql
DROP TABLE fetch_content, fetch_attempts, fetch_requests, routing_rule_audit, routing_rules, site_routes, captcha_solves, admin_probes,
  split_gateway_webhook_secrets;
```
