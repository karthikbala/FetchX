# API

The contract is [`openapi.json`](openapi.json); `test/api-contract.test.mjs` holds the platform to it. The published guide at [fetchx.ai/docs](https://fetchx.ai/docs) is built from the same file (`website/src/data/api-docs.ts`). This page is the short version for people working on the code.

## Endpoints

| Method and path | Key scope | What it does |
| --- | --- | --- |
| `POST /v1/fetch` | `fetch:write` | Get a URL. 200 when finished (`succeeded` or `failed`), 202 while running |
| `POST /v1/fetch/{id}/next` | `fetch:write` | Get the page after request `{id}`'s, as a new request (same answers as `POST /v1/fetch`) |
| `GET /v1/fetch` | `fetch:read` | List requests, newest first: `status`, `tag`, `idempotency_key`, `since`, `limit`, `cursor` |
| `GET /v1/fetch/{id}` | `fetch:read` | The result; `include_body=false` for polling |
| `GET /v1/fetch/{id}/content` | `fetch:read` | The body as received, with its Content-Type |
| `GET /v1/fetch/{id}/screenshot` | `fetch:read` | The JPEG screenshot |
| `DELETE /v1/fetch/{id}` | `fetch:read` | Delete everything the site sent, now |
| `GET /v1/usage` | `usage:read` | Balance and usage for a day, a month or a range |

Keys are `fxk_` console keys with scopes, or a `tokenHash` in `config.projects` (unmetered, all scopes). The console API (`/control/...`, behind the website's bridge) mirrors these per project; see [console](console.md).

## A request's life

1. **Admission** (`FetchFront.submit` in `src/fetch/front.mjs`): check `max_credits`, the project's concurrency limit and its balance, and reserve credits in one transaction with a pending `fetch_settlements` row. Nothing has been sent yet, so every refusal here is a 4xx and free.
2. **The engine** (`EngineClient.startJob`): the request goes to the engine as sent, with the job id, the project as tenant and the cost tiers the reservation covers. The engine validates it (a refusal there is a 4xx, and the reservation is released), checks the idempotency key per project, and runs auto mode. It answers within the sync wait (60 s) or with 202.
3. **Settlement** (`FetchFront.settle`): when the engine reports the job finished (its signed event, a read of the result, or the reconciler), charge the winning step's price, at most the reservation, or release it; then queue the customer webhook. Each job settles once.
4. **Reads** (`get`, `list`, `content`, `screenshot`, `delete`) go to the engine, which stores results for 7 days, and are shown with the platform's `credits`.

If the engine's answer is lost after the job may have been sent, the reservation is kept and the reconciler finds out from the engine what happened; FetchX never resends it.

## Scrolling and next pages

`scroll` on a request (`auto` up to 10 screens, `off`, or 1 to 50 screens) is the engine's: the platform passes it on and never prices it. A scrolled page loads more, so on a residential route its extra traffic counts toward the per-MB charge like any other (Karthik, 2026-11-20); `scroll: off` avoids that.

A successful result carries `data.page` (number, `previous_id`, screens scrolled, whether it reached the end) and `data.next_page` (`link`, `click`, `scroll` or `null`). `POST /v1/fetch/{id}/next` (`FetchFront.submitNext`) goes through the same admission as a fetch: a new id, a reservation and a pending settlement row, with the ceiling of a GET. `EngineClient.startNextJob` sends `{id, tenant, request, allowed_steps}` to `/internal/v1/jobs/{previous}/next`, where `request` holds only what may change per page (`scroll`, `max_credits`, `timeout_ms`, `async`, `webhook_url`, `idempotency_key`, `tags`). The engine builds the rest from the earlier job, on the same kept session where it can. Its refusals (`404 not_found`, `409 pending`, `409 no_next_page` with `details.reason`, `410 content_expired`) release the reservation like any other refusal. A next page settles, and is charged, like any job.

## Errors

Refused calls are `{error: {code, message, details?}}` with a 4xx (`src/api/v1.mjs`). Failed fetches are HTTP 200 with `status: failed` and `error: {code, message, next: {action, detail}}`; The engine maps each code to the next step. The code lists are in the contract and in the [published errors page](https://fetchx.ai/docs/errors).

## Changing the API

Change `openapi.json` first, run `npm run api:generate` for the client types, then the code. The contract test fails on an undocumented route, a wrong scope, or a real response that does not match its schema.
