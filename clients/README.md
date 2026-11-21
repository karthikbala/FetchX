# FetchX clients

## Connect a coding agent

On a deployment with FetchX Connect enabled, use Node.js 24 to run a command with an approved project's credentials in its environment.

```sh
node clients/connect.mjs -- codex
```

Use your own agent command in place of `codex`. Share the displayed link and short code with the user. The user signs in, enters the short code and approves a project within ten minutes. Keep the Connect process running while they approve.

The wrapper starts the command with `FETCHX_URL` and `FETCHX_TOKEN` in its environment. The command must keep `FETCHX_TOKEN` private and use it only for requests to `FETCHX_URL`. A Node.js integration can call the helper directly:

```js
import {connectFetchX} from './connect.mjs';
import {FetchXClient} from './javascript.mjs';

const {token, apiBaseUrl} = await connectFetchX({
  clientName: 'My coding agent',
  onApproval: ({verificationUri, userCode}) => console.error(`Open ${verificationUri}\nFetchX code: ${userCode}`),
});
const fetchx = new FetchXClient({url: apiBaseUrl, token});
console.log((await fetchx.balance()).credits);
```

The hosted helper is published as [connect-client.mjs](https://fetchx.ai/connect-client.mjs). For a self-hosted deployment, pass `--origin` (helper option `origin`) and, if the API uses another origin, `--api-origin` (`apiOrigin`). If Connect is not available, make a key in the console and set `FETCHX_TOKEN` and `FETCHX_URL` through your runtime's secret settings.

## JavaScript and Python

Both clients wrap the [OpenAPI contract](../docs/openapi.json): one method per endpoint. JavaScript runs anywhere `fetch` exists and ships TypeScript types generated from the contract. Python needs `httpx`.

```js
import {FetchXClient} from './clients/javascript.mjs';

const fetchx = new FetchXClient({url: process.env.FETCHX_URL, token: process.env.FETCHX_TOKEN});
const result = await fetchx.fetch({url: 'https://shop.example.com/p/42', formats: ['markdown']});
if (result.status === 'succeeded') console.log(result.data.markdown);
else console.log(result.error.code, result.error.next.action, result.error.next.detail);
```

```python
import os
from clients.python import FetchXClient

fetchx = FetchXClient(os.environ['FETCHX_URL'], os.environ['FETCHX_TOKEN'])
result = fetchx.fetch(url='https://shop.example.com/p/42', formats=['markdown'])
if result['status'] == 'succeeded':
    print(result['data']['markdown'])
else:
    print(result['error']['code'], result['error']['next']['action'])
```

| Endpoint | JavaScript | Python | Key scope |
| --- | --- | --- | --- |
| `POST /v1/fetch` | `fetch(input)` | `fetch(**input)` | `fetch:write` |
| `POST /v1/fetch/{id}/next` | `nextPage(id, input)` | `next_page(id, **input)` | `fetch:write` |
| `GET /v1/fetch/{id}` | `get(id, {includeBody})`, `wait(id)` | `get(id, include_body=)`, `wait(id)` | `fetch:read` |
| `GET /v1/fetch` | `list(query)` | `list(...)` | `fetch:read` |
| `GET /v1/fetch/{id}/content` | `content(id)` | `content(id)` | `fetch:read` |
| `GET /v1/fetch/{id}/screenshot` | `screenshot(id)` | `screenshot(id)` | `fetch:read` |
| `DELETE /v1/fetch/{id}` | `delete(id)` | `delete(id)` | `fetch:read` |
| `POST /v1/estimate` | `estimate(input)` | `estimate(**input)` | `fetch:write` |
| `GET /v1/balance` | `balance()` | `balance()` | `usage:read` |
| `GET /v1/usage` | `usage(query)` | `usage(...)` | `usage:read` |
| `GET /v1/status` | `status()` | `status()` | none |

## Scrolling and next pages

A page opened in a browser is scrolled up to 10 screens by default while scrolling loads more. Pass `scroll: 'off'` to read only what loads without scrolling (the cheapest choice when the first screen is enough), or a number from 1 to 50 for more screens (with a higher `timeout_ms` for many).

A successful result says how the page leads on in `data.next_page` (a `link`, a `click` on a Next or Load more button, or more `scroll`ing), or `null`. `nextPage(id)` gets that page as a new request, with the earlier request's settings and cookies and, where it can, the same residential browser session. The new result has its own `next_page`, so a list is read by following each new id:

```js
let result = await fetchx.fetch({url: 'https://shop.example.com/search?q=lamp', formats: ['markdown']});
const pages = [result];
while (result.status === 'succeeded' && result.data.next_page && pages.length < 5) {
  result = await fetchx.nextPage(result.id);
  pages.push(result);
}
```

Each next page is billed like any request: only when it succeeds, at the price of the step that got it.

## Estimates before you send

`estimate(input)` takes the body you would send to `fetch`, or a batch (`{items: [url, {url, ...}], defaults: {...}}`), and says what it would cost and take without sending or reserving anything: `credits.typical` and `credits.high` for a success, `credits.expected` counting only the share of requests that usually succeed (failures are free), `credits.hold` reserved while a request runs, and `seconds`. Each item's `basis` says whether the figures come from that site's recent requests (`history`) or are typical ones, and `notes` say what to change when a request would be refused or is likely to fail (for example a `max_credits` below the step the site needs).

```js
const estimate = await fetchx.estimate({items: urls, defaults: {formats: ['markdown']}});
if (!estimate.balance.covers_expected) console.log(estimate.notes);
```

## Outcomes, errors and retries

A fetch that ran returns its result whether it succeeded or not: check `status`. A failed result has `error.code`, a one-line `error.message` and `error.next` (an `action` and a `detail`) that an agent can act on, and `data` holds what the site last answered. A pending result (`async: true`, or longer than 60 seconds) comes back with `status: 'pending'`; `wait(id)` polls until it finishes.

A refused call (4xx) throws `FetchXError` with `code`, `status`, `details` and `retryAfterSeconds` (`retry_after_seconds` in Python). Nothing was sent to the site and nothing was charged. During maintenance every call except `status()` is answered with `maintenance` (HTTP 503), `retryAfterSeconds` and `details.status_url`: `fetch` and `nextPage` wait and resend it like any 503, and a call that still meets it throws it. Nothing was run or charged. A route that was retired throws `route_retired` (410) with `details.replacement`. Changes to the API are listed at https://fetchx.ai/changelog.

`fetch` and `nextPage` always send an `idempotency_key`, generated when you leave it out. After a lost response, a `429` or a `503` it resends the same body with the same key up to `retries` times (default 2). FetchX returns the first result for a key and never charges twice, so a resend is safe. Keep the key with your own record of the request if you need to find it later with `list({idempotency_key})`.

## JSON in your own shape

Pass `extract` with a small JSON Schema; each field's `description` says what it is. `data.extract` holds the result, and `data.extract_report` says how each field was read. A root `array` (with a `description` of one record) returns every record of that kind on a list page, and a next page reads its page with the same `extract`.

```js
const result = await fetchx.fetch({url: 'https://shop.example.com/p/42', extract: {schema: {type: 'object', required: ['price'],
  properties: {name: {type: 'string', description: 'Product name'}, price: {type: 'number', description: 'Price in the page currency'}}}}});
if (result.status === 'succeeded') console.log(result.data.extract); // {name: '...', price: 19.99}
```

A value the page does not show is `null`, never guessed. A `required` field the page does not show fails the request with `content_missing`, uncharged, after FetchX has tried a browser and fresh IPs. Extraction adds 10 credits per started 25,000 tokens of page text read (`credits.breakdown.extract_credits`). When it is unavailable, the call is refused with `extract_unavailable` (503) before anything is fetched; the clients do not retry it on their own.
