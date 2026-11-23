# API

The contract is [`openapi.json`](openapi.json); `test/api-contract.test.mjs` holds the platform to it. The published guide at [fetchx.ai/docs](https://fetchx.ai/docs) is built from the same file (`website/src/data/api-docs.ts`). This page is the short version for people working on the code.

## Endpoints

| Method and path | Key scope | What it does |
| --- | --- | --- |
| `POST /v1/fetch` | `fetch:write` | Get a URL. 200 when finished (`succeeded` or `failed`), 202 while running |
| `POST /v1/fetch/{id}/next` | `fetch:write` | Get the page after request `{id}`'s, as a new request (same answers as `POST /v1/fetch`) |
| `GET /v1/fetch` | `fetch:read` | List requests, newest first: `status`, `tag`, `idempotency_key`, `since`, `limit`, `cursor` |
| `GET /v1/fetch/{id}` | `fetch:read` | The result; `include_body=false` for polling (the body only appears when `formats` asked for `body`) |
| `GET /v1/fetch/{id}/content` | `fetch:read` | The body as received, with its Content-Type |
| `GET /v1/fetch/{id}/screenshot` | `fetch:read` | The JPEG screenshot |
| `GET /v1/fetch/{id}/network` | `fetch:read` | A request made with `capture`: the page's recorded calls, filtered (`type`, `content_type`, `host`, `first_party`, `status`, `page`, `phase`), searched (`contains`, up to 5 values) and paged |
| `GET /v1/fetch/{id}/network/{index}` | `fetch:read` | One recorded call in full: headers (secrets masked unless `unmask`), request and response bodies (over 1 MB by `body_url`) |
| `GET /v1/fetch/{id}/network/{index}/body` | `fetch:read` | One recorded call's response body, as stored |
| `GET /v1/fetch/{id}/network.har` | `fetch:read` | The recorded calls as HAR 1.2, optionally one `page` |
| `DELETE /v1/fetch/{id}` | `fetch:read` | Delete everything the site sent, now |
| `POST /v1/batches` | `fetch:write` | Many URLs in one job (up to 1000), checked whole, then run at each site's pace. 202 queued, 200 for a replayed key |
| `GET /v1/batches` | `fetch:read` | List batches, newest first: `status`, `limit`, `cursor` |
| `GET /v1/batches/{id}` | `fetch:read` | The batch: status, item counts, credits charged |
| `GET /v1/batches/{id}/items` | `fetch:read` | Its items with their results: `order=index` (default) or `order=finished` (a feed), `status`, `results`, `limit`, `cursor` |
| `POST /v1/batches/{id}/cancel` | `fetch:write` | Stop the items that have not started |
| `GET /v1/balance` | `usage:read` | Credits available now, reserved, trial and purchased, and whether a payment hold is on |
| `GET /v1/usage` | `usage:read` | Balance and usage for a day, a month or a range |
| `GET /v1/me` | any valid key | The calling project (`project_id`, the same after a key is rotated) and key (`key_id`, `key_name`, `key_prefix`, `scopes`), and the key's `limits` with what it has used |
| `POST /v1/feedback` | `fetch:write` | Report how FetchX handled a page: `fetch_id` or `url`, `kind`, `message`, `evidence`. 201 new, 200 for the same open report. Free, 100 a day per project |
| `GET /v1/feedback/{id}` | `fetch:read` | A report's `status` (received, reviewing, resolved, dismissed) and staff's `reply` |
| `POST /v1/estimate` | `fetch:write` | What a request, or a batch of up to 1,000, would cost and how long it would take. Nothing is sent, reserved or charged |
| `GET /v1/status` | none | The API's state, components and notices; answers during maintenance and to any origin |

Keys are `fxk_` console keys with scopes, or a `tokenHash` in `config.projects` (unmetered, all scopes; `GET /v1/me` shows such a key with null `key_id`, `key_name` and `key_prefix`). An operation's `x-scope` in the contract is the scope it needs, or `any` for one every valid key may call (`ANY_SCOPE` in `src/api/v1.mjs`). The console API (`/control/...`, behind the website's bridge) mirrors these per project; see [console](console.md).

## A request's life

1. **Admission** (`FetchFront.submit` in `src/fetch/front.mjs`): check `max_credits`, the project's concurrency limit and its balance, and reserve credits in one transaction with a pending `fetch_settlements` row. Nothing has been sent yet, so every refusal here is a 4xx and free.
2. **The engine** (`EngineClient.startJob`): the request goes to the engine as sent, with the job id, the project as tenant and the cost tiers the reservation covers. The engine validates it (a refusal there is a 4xx, and the reservation is released), checks the idempotency key per project, and runs auto mode. It answers within the sync wait (60 s) or with 202.
3. **Settlement** (`FetchFront.settle`): when the engine reports the job finished (its signed event, a read of the result, or the reconciler), charge the winning step's price, at most the reservation, or release it; then queue the customer webhook. Each job settles once.
4. **Reads** (`get`, `list`, `content`, `screenshot`, `delete`) go to the engine, which stores results for 7 days, and are shown with the platform's `credits`: `charged`, `max`, the project's `balance` now and, for a success, a `breakdown` from the settlement row (step price, captcha, traffic MB, MB included, traffic credits).

If the engine's answer is lost after the job may have been sent, the reservation is kept and the reconciler finds out from the engine what happened; FetchX never resends it.

## Scrolling and next pages

`scroll` on a request (`auto` up to 10 screens, `off`, or 1 to 50 screens) is the engine's: the platform passes it on and never prices it. A scrolled page loads more, so on a residential route its extra traffic counts toward the per-MB charge like any other (Karthik, 2026-11-20); `scroll: off` avoids that.

A successful result carries `data.page` (number, `previous_id`, screens scrolled, whether it reached the end) and `data.next_page` (`link`, `click`, `scroll` or `null`). `POST /v1/fetch/{id}/next` (`FetchFront.submitNext`) goes through the same admission as a fetch: a new id, a reservation and a pending settlement row, with the ceiling of a GET that may load the deepest page's traffic (150 MB; `PAGE_DEPTH` in `src/fetch/front.mjs`, the engine's limit). A fetch with `scroll` past 10 reserves for 2.5 MB more a screen. `EngineClient.startNextJob` sends `{id, tenant, request, allowed_steps}` to `/internal/v1/jobs/{previous}/next`, where `request` holds only what may change per page (`scroll`, `max_credits`, `timeout_ms`, `async`, `webhook_url`, `idempotency_key`, `tags`). The engine builds the rest from the earlier job, on the same kept session where it can. Its refusals (`404 not_found`, `409 pending`, `409 no_next_page` with `details.reason`, `410 content_expired`) release the reservation like any other refusal. A next page settles, and is charged, like any job.

## Key limits

A console key can carry a credit limit per UTC day and per UTC month and an expiry (`control_keys.credit_limit_day`, `credit_limit_month`, `expires_at`; set at creation or with `PUT /control/projects/{id}/keys/{key}/limits`). `src/fetch/key-limits.mjs` (`keyLimitState`) counts a key's spend from `fetch_settlements`: `credits_charged` of settled rows plus `credits_max` of pending ones, by `created_at`, over every key of its `lineage` (a rotated key keeps its predecessor's lineage, limits and expiry, so rotation does not reset them). `FetchFront.#start` reads it inside the project's ledger lock and reserves at most the room left; when that leaves no allowed step, the engine's `budget_too_low` is told back as `402 key_limit_reached` (`#budgetError`, details `limit`, `credits`, `used`, `remaining`, `needed`, `resets_at`). A batch item waits (`credits_busy`) while the key's own requests hold credits; a batch whose key has no room pauses with `paused_reason: key_limit_reached` until `resets_at`, and `POST /v1/batches` refuses a batch when the key has no room for one item. `authenticateKey` answers an expired key with `401 api_key_expired`. Keys from `config.projects` have no limits.

## Feedback

`src/fetch/feedback.mjs` keeps callers' reports in `fetch_feedback`. A report names a request of the project (`fetch_id`) or a `url` and `method`; with `fetch_id` it reads the job from the engine (`404 not_found` when it is not the project's or no longer kept) and stores a copy of what FetchX did (`fetch_record`: status, page_status, error code, challenge vendor and up to 12 attempts with transport, IP class, country, result and status code), so the report outlives the result. An open report (`received` or `reviewing`) of the same kind about the same request, or the same URL and method, is returned instead of a new one (200). A project may send `FEEDBACK_PER_DAY` (100) per UTC day, then `429 too_many_requests` until midnight UTC. Rows are pruned with request metadata (90 days). Operators read them in the admin portal's Feedback tab (`GET /control/admin/feedback`, open reports first, with the project name) and set `status` and `reply` (`PUT /control/admin/feedback/{id}`, recorded as `reviewed_by`); the reply is what `GET /v1/feedback/{id}` shows the caller. Nothing about feedback reaches the engine or changes routing by itself.

## Network capture

`capture` on a request (`true` or settings, see the contract's `CaptureSettings`) is the engine's: the platform passes it on, never prices it, and serves the four `/v1/fetch/{id}/network...` routes from the engine's `/internal/v1/jobs/{id}/network...` with the project as tenant (`EngineClient.networkList`, `networkCall`, `networkBody`, `networkHar`; the query is passed on as sent, `contains` repeated). The engine records the calls in the browser, masks secret headers, drops trackers, stores the calls as content (7 days or `DELETE`, then `410 content_expired`) and answers `404 capture_not_found` for a request made without it; see the engine's `docs/browser.md`. A request with `capture` needs a browser, so the engine refuses it with `render: never`, a method other than GET or a route without a browser (`400 invalid_request`, field `capture`); the platform's reservation is released like any refusal. The result's `network` summary (top level, also on a failed result) comes from the engine unchanged.

## Batches

A batch (`src/fetch/batches.mjs`) is a queue of ordinary requests. Nothing is reserved up front; each item is admitted, reserved, charged and released like a single request when it starts.

1. **Submit** (`BatchService.submit`): `expandBatch` lays each item over `defaults`, the platform checks what it bills from (`FetchFront.billingCheck`), and the engine checks the rest without storing anything (`POST /internal/v1/requests/check`, which also says which host each item is paced under). One bad item refuses the batch with its place (`items[3].formats` or `defaults.formats`). Metered projects need a balance that covers the cheapest step. The batch and its items are stored in one transaction (`fetch_batches`, `fetch_batch_items`, defaults, items and webhook URL sealed).
2. **The queue** (`BatchRunner`, every second, after each settlement, and when a host's next spaced start falls due): resume paused batches the balance now covers, ask the engine for the pace of each host with queued items (`POST /internal/v1/pace`), and start what fits. Nothing starts while the engine has browser work waiting. Hosts take turns, one start each per round; on one host, batches take turns by when that host last served them. Each project keeps one of its requests-at-once for single requests.
3. **An item's start** (`FetchFront.startBatchItem`): the same admission as `submit`, with the item claimed (marked running) in the reservation's transaction and the job sent `paced: true` with the item's own key, `batch.<id>.<index>`. The engine refuses a paced job with `429 host_busy` when its host has no free slot; the reservation is released and the item waits. An item does not start with less than its full reservation while the project's other requests hold credits (`credits_busy`, internal): it waits for them. When the balance cannot cover the cheapest step at all, the batch pauses with `paused_reason` and a `batch.paused` event. When the engine refuses an item with `extract_unavailable` (its items ask for `extract` and extraction can't run), the batch pauses with that reason and `paused_until` 5 minutes on (or the refusal's `retry_after_seconds`), and the queue resumes it once that time has passed.
4. **Settlement**: the settle transaction also finishes the item (`BatchService.settled`), queues its `fetch.finished` webhook to the batch's URL with `batch: {id, index}`, and finishes the batch (`batch.finished`) after its last item. A job dropped before it started (`#discard`) puts its item back in the queue.

Recovery: a lost start answer stays pending for the reconciler, which settles the item from the engine or, when the engine never had the job, discards it and requeues the item; an item claimed but never reserved (a crash between the two) is requeued after 10 minutes; a key the engine already had (a restart after an uncertain start) links the item to that job. The item's key means the engine never runs it twice.

The engine decides the pace (`src/fetch/pace.mjs` there): open hosts 4 at once and 0.5 s apart, hosts that refused or rate-limited FetchX before 2 at once and 4 s apart, hosts rate-limited in the last 10 minutes 1 at a time and 15 s apart, from its shared site knowledge. Every job counts toward its host, single requests included; only batch items wait.

## Estimates

`POST /v1/estimate` (`Estimator` in `src/fetch/estimate.mjs`) takes a fetch body, or a batch body `{items, defaults}` in the batch API's shape (`expandEstimateBody`: items are URLs or request objects shallow-merged over `defaults`, 1 to 1,000). The engine's `POST /internal/v1/estimates` validates each request as `POST /v1/fetch` would, plans its ladder with the site knowledge it has, and returns each host's recent usage (`site_usage`: the last 100 finished requests per host, shared across customers by host name only, never by tenant) and the batch pace per host. The platform prices that with `DEFAULT_PRICES` and the reservation ceiling (`FetchFront.holdFor`), so the engine stays price-free.

Each item gets `credits` (`typical` and `high` for one success, `expected` weighted by the site's success rate, `hold` while it runs), `seconds`, `basis` (`history`, `routes`, `defaults`, `assumed`) and `notes` with what to change (`max_credits_too_low`, `insufficient_credits`, `likely_needs_more_credits`, `cooling_down`, `low_success_rate`, `no_route`, `no_history`, `balance_may_run_out`, `extract_priced_by_text`). With `extract`, `typical` counts one unit of extraction and `high` the most a page can cost. A batch also gets per-host `pace` and a total time: per host, `max(n × start gap, work / at once)`, the slowest host, and at least the work spread over what can run at once. That is the project's concurrency less the one slot kept for single requests, and no more than the balance can hold, since each running request holds its worst-case reservation (`balance_limits_pace` says when the balance is the limit).

## Status, maintenance and retired routes

`src/status.mjs` keeps operators' notices (`status_notices`: incidents and maintenance, with timed updates) and builds `GET /v1/status`. A maintenance notice with `pause_api` makes every `/v1` route except `GET /v1/status` answer `503 maintenance` with `Retry-After` while it is active (`registerLifecycle` in `src/api/lifecycle.mjs`). Operators post and resolve notices in the admin portal's Status tab (`/control/admin/notices`). The status page at fetchx.ai/status does not depend on the gateway; see [operations](operations.md#status-page-and-maintenance).

[`changelog.json`](changelog.json) is the record of what changed, newest first. `retired` entries make a route answer `410 route_retired` with `error.details.replacement`; `deprecations` add `Deprecation` (RFC 9745), `Sunset` (RFC 8594) and `Link: rel="deprecation"` headers to a route that still works. Any other unknown route answers `404 route_not_found` with links to the docs, changelog and status page. The website's `/changelog`, `/changelog.json` and `/changelog.xml` are built from the same file, and `API_VERSION` (`src/api/version.mjs`) is its newest release.

## Errors

Refused calls are `{error: {code, message, details?}}` with a 4xx (`src/api/v1.mjs`). A key over its own credit limit is `402 key_limit_reached` and an expired key `401 api_key_expired` (see Key limits). A `503 unavailable` (the engine could not be reached or answered badly) carries `Retry-After: 30`, `retry_after_seconds` and `details.status_url`, so a client waits and resends with the same key. They store nothing under the idempotency key, so the caller can resend with the same key, except after `409 idempotency_conflict`. Failed fetches are HTTP 200 with `status: failed` and `error: {code, message, next: {action, retry_after_seconds?, retry_with_new_key, detail}}`; the engine maps each code to the next step (`nextAction` in the engine's `src/fetch/service.mjs`). A key replays its first result for 90 days, failures included, so `retry_with_new_key` says whether sending the request again with a new key can help. The code lists are in the contract and in the [published errors page](https://fetchx.ai/docs/errors), which has one row per code with its action and whether to retry.

Every result has `page_status` (`content`, `not_found`, `empty`, `challenge`, `error`, null while pending) and `challenge` (the bot-protection vendor met, how many attempts met a wall, and whether rotation, a captcha or a wait got past it). Both come from the engine unchanged.

## Changing the API

Change `openapi.json` first, run `npm run api:generate` for the client types, then the code. The contract test fails on an undocumented route, a wrong scope, or a real response that does not match its schema.

Every change customers can see also goes in [`changelog.json`](changelog.json): add it to a new release at the top (bump `info.version` in `openapi.json` to match) or to the unreleased one you are already adding to. Removing or breaking a route is two steps. First add a `deprecations` entry (`path` as in the contract, e.g. `/v1/fetch/{id}`, `method`, `deprecated_in`, `deprecated_on`, `sunset_on` at least `policy.notice_days` (30) days later, `replacement`) and ship it; the route keeps working with the headers. After the sunset, remove the route, move the entry to `retired` (`retired_in`, `retired_on`, `replacement`, `match: "prefix"` for a whole subtree) and ship that.
