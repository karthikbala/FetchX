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
| `DELETE /v1/fetch/{id}` | `fetch:read` | Delete everything the site sent, now |
| `GET /v1/balance` | `usage:read` | Credits available now, reserved, trial and purchased, and whether a payment hold is on |
| `GET /v1/usage` | `usage:read` | Balance and usage for a day, a month or a range |
| `POST /v1/estimate` | `fetch:write` | What a request, or a batch of up to 1,000, would cost and how long it would take. Nothing is sent, reserved or charged |
| `GET /v1/status` | none | The API's state, components and notices; answers during maintenance and to any origin |

Keys are `fxk_` console keys with scopes, or a `tokenHash` in `config.projects` (unmetered, all scopes). The console API (`/control/...`, behind the website's bridge) mirrors these per project; see [console](console.md).

## A request's life

1. **Admission** (`FetchFront.submit` in `src/fetch/front.mjs`): check `max_credits`, the project's concurrency limit and its balance, and reserve credits in one transaction with a pending `fetch_settlements` row. Nothing has been sent yet, so every refusal here is a 4xx and free.
2. **The engine** (`EngineClient.startJob`): the request goes to the engine as sent, with the job id, the project as tenant and the cost tiers the reservation covers. The engine validates it (a refusal there is a 4xx, and the reservation is released), checks the idempotency key per project, and runs auto mode. It answers within the sync wait (60 s) or with 202.
3. **Settlement** (`FetchFront.settle`): when the engine reports the job finished (its signed event, a read of the result, or the reconciler), charge the winning step's price, at most the reservation, or release it; then queue the customer webhook. Each job settles once.
4. **Reads** (`get`, `list`, `content`, `screenshot`, `delete`) go to the engine, which stores results for 7 days, and are shown with the platform's `credits`: `charged`, `max`, the project's `balance` now and, for a success, a `breakdown` from the settlement row (step price, captcha, traffic MB, MB included, traffic credits).

If the engine's answer is lost after the job may have been sent, the reservation is kept and the reconciler finds out from the engine what happened; FetchX never resends it.

## Scrolling and next pages

`scroll` on a request (`auto` up to 10 screens, `off`, or 1 to 50 screens) is the engine's: the platform passes it on and never prices it. A scrolled page loads more, so on a residential route its extra traffic counts toward the per-MB charge like any other (Karthik, 2026-11-20); `scroll: off` avoids that.

A successful result carries `data.page` (number, `previous_id`, screens scrolled, whether it reached the end) and `data.next_page` (`link`, `click`, `scroll` or `null`). `POST /v1/fetch/{id}/next` (`FetchFront.submitNext`) goes through the same admission as a fetch: a new id, a reservation and a pending settlement row, with the ceiling of a GET that may load the deepest page's traffic (150 MB; `PAGE_DEPTH` in `src/fetch/front.mjs`, the engine's limit). A fetch with `scroll` past 10 reserves for 2.5 MB more a screen. `EngineClient.startNextJob` sends `{id, tenant, request, allowed_steps}` to `/internal/v1/jobs/{previous}/next`, where `request` holds only what may change per page (`scroll`, `max_credits`, `timeout_ms`, `async`, `webhook_url`, `idempotency_key`, `tags`). The engine builds the rest from the earlier job, on the same kept session where it can. Its refusals (`404 not_found`, `409 pending`, `409 no_next_page` with `details.reason`, `410 content_expired`) release the reservation like any other refusal. A next page settles, and is charged, like any job.

## Estimates

`POST /v1/estimate` (`Estimator` in `src/fetch/estimate.mjs`) takes a fetch body, or a batch body `{items, defaults}` in the batch API's shape (`expandEstimateBody`: items are URLs or request objects shallow-merged over `defaults`, 1 to 1,000). The engine's `POST /internal/v1/estimates` validates each request as `POST /v1/fetch` would, plans its ladder with the site knowledge it has, and returns each host's recent usage (`site_usage`: the last 100 finished requests per host, shared across customers by host name only, never by tenant) and the batch pace per host. The platform prices that with `DEFAULT_PRICES` and the reservation ceiling (`FetchFront.holdFor`), so the engine stays price-free.

Each item gets `credits` (`typical` and `high` for one success, `expected` weighted by the site's success rate, `hold` while it runs), `seconds`, `basis` (`history`, `routes`, `defaults`, `assumed`) and `notes` with what to change (`max_credits_too_low`, `insufficient_credits`, `likely_needs_more_credits`, `cooling_down`, `low_success_rate`, `no_route`, `no_history`, `balance_may_run_out`). A batch also gets per-host `pace` and a total time: per host, `max(n × start gap, work / at once)`, the slowest host, and at least the work spread over what can run at once. That is the project's concurrency less the one slot kept for single requests, and no more than the balance can hold, since each running request holds its worst-case reservation (`balance_limits_pace` says when the balance is the limit).

## Status, maintenance and retired routes

`src/status.mjs` keeps operators' notices (`status_notices`: incidents and maintenance, with timed updates) and builds `GET /v1/status`. A maintenance notice with `pause_api` makes every `/v1` route except `GET /v1/status` answer `503 maintenance` with `Retry-After` while it is active (`registerLifecycle` in `src/api/lifecycle.mjs`). Operators post and resolve notices in the admin portal's Status tab (`/control/admin/notices`). The status page at fetchx.ai/status does not depend on the gateway; see [operations](operations.md#status-page-and-maintenance).

[`changelog.json`](changelog.json) is the record of what changed, newest first. `retired` entries make a route answer `410 route_retired` with `error.details.replacement`; `deprecations` add `Deprecation` (RFC 9745), `Sunset` (RFC 8594) and `Link: rel="deprecation"` headers to a route that still works. Any other unknown route answers `404 route_not_found` with links to the docs, changelog and status page. The website's `/changelog`, `/changelog.json` and `/changelog.xml` are built from the same file, and `API_VERSION` (`src/api/version.mjs`) is its newest release.

## Errors

Refused calls are `{error: {code, message, details?}}` with a 4xx (`src/api/v1.mjs`). They store nothing under the idempotency key, so the caller can resend with the same key, except after `409 idempotency_conflict`. Failed fetches are HTTP 200 with `status: failed` and `error: {code, message, next: {action, retry_after_seconds?, retry_with_new_key, detail}}`; the engine maps each code to the next step (`nextAction` in the engine's `src/fetch/service.mjs`). A key replays its first result for 90 days, failures included, so `retry_with_new_key` says whether sending the request again with a new key can help. The code lists are in the contract and in the [published errors page](https://fetchx.ai/docs/errors), which has one row per code with its action and whether to retry.

Every result has `page_status` (`content`, `not_found`, `empty`, `challenge`, `error`, null while pending) and `challenge` (the bot-protection vendor met, how many attempts met a wall, and whether rotation, a captcha or a wait got past it). Both come from the engine unchanged.

## Changing the API

Change `openapi.json` first, run `npm run api:generate` for the client types, then the code. The contract test fails on an undocumented route, a wrong scope, or a real response that does not match its schema.

Every change customers can see also goes in [`changelog.json`](changelog.json): add it to a new release at the top (bump `info.version` in `openapi.json` to match) or to the unreleased one you are already adding to. Removing or breaking a route is two steps. First add a `deprecations` entry (`path` as in the contract, e.g. `/v1/fetch/{id}`, `method`, `deprecated_in`, `deprecated_on`, `sunset_on` at least `policy.notice_days` (30) days later, `replacement`) and ship it; the route keeps working with the headers. After the sunset, remove the route, move the entry to `retired` (`retired_in`, `retired_on`, `replacement`, `match: "prefix"` for a whole subtree) and ship that.
