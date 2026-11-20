# API

The contract is [`openapi.json`](openapi.json); `test/api-contract.test.mjs` holds the gateway to it. The published guide at [fetchx.ai/docs](https://fetchx.ai/docs) is built from the same file (`website/src/data/api-docs.ts`). This page is the short version for people working on the code.

## Endpoints

| Method and path | Key scope | What it does |
| --- | --- | --- |
| `POST /v1/fetch` | `fetch:write` | Get a URL. 200 when finished (`succeeded` or `failed`), 202 while running |
| `GET /v1/fetch` | `fetch:read` | List requests, newest first: `status`, `tag`, `idempotency_key`, `since`, `limit`, `cursor` |
| `GET /v1/fetch/{id}` | `fetch:read` | The result; `include_body=false` for polling |
| `GET /v1/fetch/{id}/content` | `fetch:read` | The body as received, with its Content-Type |
| `GET /v1/fetch/{id}/screenshot` | `fetch:read` | The JPEG screenshot |
| `DELETE /v1/fetch/{id}` | `fetch:read` | Delete everything the site sent, now |
| `GET /v1/usage` | `usage:read` | Balance and usage for a day, a month or a range |

Keys are `fxk_` console keys with scopes, or a `tokenHash` in `config.projects` (unmetered, all scopes). The console API (`/control/...`, behind the website's bridge) mirrors these per project; see [console](console.md).

## A request's life

1. **Admission** (`FetchService.submit`): parse and validate (`src/fetch/request.mjs`), check the idempotency key (same key and body returns the stored result; a different body is a 409), the project's concurrency limit, and plan the ladder (`src/fetch/ladder.mjs`). Credits are reserved: at least the cheapest step, at most `max_credits` or the most expensive step. Nothing has been sent yet, so every refusal here is a 4xx and free.
2. **The ladder** (`FetchService.#run`): each step is an HTTP attempt (`http-attempt.mjs`, redirects followed and re-checked) or a browser attempt (`browser-attempt.mjs`, through a worker and the egress relay). Each response is classified (`outcome.mjs`): `success`, `answered` (a real 404/410), `blocked`, `rate_limited`, `login_required`, `site_error`, `needs_browser`. The next step depends on the last result: a 429 goes to a fresh residential IP, a JavaScript shell to a browser, a wall on a residential browser to another residential browser on a fresh IP. A browser page that shows nothing is `blocked`. Steps refused before anything was sent (`not_admitted`) do not count against `max_attempts`.
3. **Finish** (`#finish`): on success, charge the winning step's price (`billing/ledger.mjs`), at most the reservation; otherwise release it. Store the summary with the request and everything the site sent in `fetch_content` (sealed, deleted after 7 days or on DELETE). Deliver the webhook.
4. **Learning** (`#learn`): every attempt updates `site_routes` for the host ([site knowledge](site-knowledge.md)).

A request still running when the gateway stops is closed as `uncertain` at the next start and its credits released; FetchX never resends it.

## Errors

Refused calls are `{error: {code, message, details?}}` with a 4xx (`src/api/v1.mjs`). Failed fetches are HTTP 200 with `status: failed` and `error: {code, message, next: {action, detail}}`; `nextAction()` in `src/fetch/service.mjs` maps each code to the next step. The code lists are in the contract and in the [published errors page](https://fetchx.ai/docs/errors).

## Changing the API

Change `openapi.json` first, run `npm run api:generate` for the client types, then the code. The contract test fails on an undocumented route, a wrong scope, or a real response that does not match its schema.
