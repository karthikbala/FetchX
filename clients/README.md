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
| `GET /v1/fetch/{id}/network` | `network(id, query)` | `network(id, ...)` | `fetch:read` |
| `GET /v1/fetch/{id}/network/{index}` | `networkCall(id, index)` | `network_call(id, index)` | `fetch:read` |
| `GET /v1/fetch/{id}/network/{index}/body` | `networkBody(id, index)` | `network_body(id, index)` | `fetch:read` |
| `GET /v1/fetch/{id}/network.har` | `networkHar(id, {page})` | `network_har(id, page=)` | `fetch:read` |
| `DELETE /v1/fetch/{id}` | `delete(id)` | `delete(id)` | `fetch:read` |
| `POST /v1/batches` | `submitBatch(input)` | `submit_batch(items, **batch)` | `fetch:write` |
| `GET /v1/batches/{id}` | `getBatch(id)` | `get_batch(id)` | `fetch:read` |
| `GET /v1/batches` | `listBatches(query)` | `list_batches(...)` | `fetch:read` |
| `GET /v1/batches/{id}/items` | `batchItems(id, query)`, `batchResults(id)` | `batch_items(id, ...)`, `batch_results(id)` | `fetch:read` |
| `POST /v1/batches/{id}/cancel` | `cancelBatch(id)` | `cancel_batch(id)` | `fetch:write` |
| `POST /v1/estimate` | `estimate(input)` | `estimate(**input)` | `fetch:write` |
| `GET /v1/balance` | `balance()` | `balance()` | `usage:read` |
| `GET /v1/usage` | `usage(query)` | `usage(...)` | `usage:read` |
| `GET /v1/me` | `me()` | `me()` | any key |
| `GET /v1/status` | `status()` | `status()` | none |

## Python SDK

For applications and crawlers there is also a Python package in [`python-sdk/`](python-sdk/README.md) (`import fetchx`, Python 3.9+). On top of the endpoints it waits through 202s, resends with the same key, can follow `error.next` with a new key when FetchX says that helps, sends one request at a time per site, caps credits per request and per client, calls a hook after every call, has an asyncio client, and ships an in-memory `FakeFetchX` for offline tests:

```sh
pip install "fetchx-sdk @ git+https://github.com/karthikbala/FetchX#subdirectory=clients/python-sdk"
```

```python
from fetchx import FetchX

fx = FetchX(max_credits=60)  # FETCHX_TOKEN from the environment
result = fx.fetch(url='https://shop.example.com/p/42', formats=['markdown'])
print(result.markdown if result.ok else (result.error_code, result.next_action))
```

`python.py` stays the single file to copy, returning the API's JSON as dicts.

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

## The page's own network calls

Pass `capture: true` (or an object of settings) and a browser records the calls the page makes while it loads and scrolls: its documents, XHR and fetch requests, with headers and response bodies. Many pages fill themselves from a JSON API, and the call that carries the data is often a better source than the HTML. The result's `network` says how many calls were kept and dropped. `contains` finds the call that holds a value the page shows:

```js
const result = await fetchx.fetch({url: 'https://shop.example.com/search?q=lamp', capture: true});
const {items} = await fetchx.network(result.id, {contains: ['Lamp', '19.99'], content_type: 'json'});
const call = await fetchx.networkCall(result.id, items[0].index);
console.log(call.request.url, call.response.body);
```

Capture adds nothing to the price, but it needs a browser: the request is billed at a browser step, and it is refused with `render: 'never'` or a method other than GET. Calls to analytics, advertising and consent hosts are dropped unless `include_trackers` is set, and cookies, authorization and other secret headers are masked (`<masked len=N sha=XXXXXX>`) unless `unmask` is set. The calls are kept as long as the rest of the content (7 days, or until `delete(id)`), and `networkHar(id)` returns them as a HAR file for browser developer tools. A next page keeps the earlier page's `capture` unless it sends `capture: null`.

## Who is calling

`me()` returns the project, key id, name, prefix and scopes of the key making the call, and the key's `limits`: the credit limits per day and month set on it in the console (each with `limit`, `used`, `remaining` and `resets_at`, or `null`) and `expires_at`. Any valid key may call it. `project_id` stays the same when a key is rotated, so a tool can recognise the customer by it. A request over a key's limit is refused with `key_limit_reached` (402), naming the limit and when it resets; an expired key gets `api_key_expired` (401).

## Outcomes, errors and retries

A fetch that ran returns its result whether it succeeded or not: check `status`. A failed result has `error.code`, a one-line `error.message` and `error.next` (an `action` and a `detail`) that an agent can act on, and `data` holds what the site last answered. A pending result (`async: true`, or longer than 60 seconds) comes back with `status: 'pending'`; `wait(id)` polls until it finishes.

A refused call (4xx) throws `FetchXError` with `code`, `status`, `details` and `retryAfterSeconds` (`retry_after_seconds` in Python). Nothing was sent to the site and nothing was charged. During maintenance every call except `status()` is answered with `maintenance` (HTTP 503), `retryAfterSeconds` and `details.status_url`; when FetchX cannot take work for a moment it answers `unavailable` (503) with a `Retry-After` header the same way: `fetch` and `nextPage` wait and resend it like any 503, and a call that still meets it throws it. Nothing was run or charged. A route that was retired throws `route_retired` (410) with `details.replacement`. Changes to the API are listed at https://fetchx.ai/changelog.

`fetch` and `nextPage` always send an `idempotency_key`, generated when you leave it out. After a lost response, a `429` or a `503` it resends the same body with the same key up to `retries` times (default 2). FetchX returns the first result for a key and never charges twice, so a resend is safe. Keep the key with your own record of the request if you need to find it later with `list({idempotency_key})`.

## JSON in your own shape

Pass `extract` with a small JSON Schema; each field's `description` says what it is. `data.extract` holds the result, and `data.extract_report` says how each field was read. A root `array` (with a `description` of one record) returns every record of that kind on a list page, and a next page reads its page with the same `extract`.

```js
const result = await fetchx.fetch({url: 'https://shop.example.com/p/42', extract: {schema: {type: 'object', required: ['price'],
  properties: {name: {type: 'string', description: 'Product name'}, price: {type: 'number', description: 'Price in the page currency'}}}}});
if (result.status === 'succeeded') console.log(result.data.extract); // {name: '...', price: 19.99}
```

A value the page does not show is `null`, never guessed. A `required` field the page does not show fails the request with `content_missing`, uncharged, after FetchX has tried a browser and fresh IPs. Extraction adds 10 credits per started 25,000 tokens of page text read (`credits.breakdown.extract_credits`). When it is unavailable, the call is refused with `extract_unavailable` (503) before anything is fetched; the clients do not retry it on their own.

## Batches

`submitBatch` hands FetchX up to 1000 URLs at once. FetchX runs them itself, at the pace each site can take, so there is no pacing or polling loop to write: sites run side by side, and a site that has refused or rate-limited FetchX before gets fewer requests at once, further apart. Each item is billed like a single request, only when it succeeds. Results go to `webhook_url` as each item finishes, or read them as they come with `batchResults`:

```js
const batch = await fetchx.submitBatch({
  items: ['https://shop.example.com/p/1', 'https://shop.example.com/p/2', {url: 'https://shop.example.com/search?q=lamp', scroll: 20}],
  defaults: {formats: ['markdown'], expect: {text: 'Price'}},
  idempotency_key: 'catalog-2026-11-21',
});
for await (const item of fetchx.batchResults(batch.id)) {
  if (item.status === 'succeeded') console.log(item.url, item.result.data.markdown.length);
  else console.log(item.url, item.error?.code ?? item.result?.error?.code);
}
```

Each item is `defaults` with the item's own fields on top. A bad item refuses the whole batch with a 400 naming it (`items[2].scroll`), before anything is queued.
