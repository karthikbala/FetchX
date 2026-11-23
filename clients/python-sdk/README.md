# FetchX Python SDK

A Python package for the [FetchX API](../../docs/openapi.json), with a synchronous and an asyncio client, typed results, and an in-memory FetchX for tests. It follows FetchX's rules for you: it waits through 202s, resends safely with the same idempotency key, caps what you spend, and sends one request at a time to each site. It needs Python 3.9 or newer and `httpx`.

```sh
pip install "fetchx-sdk @ git+https://github.com/karthikbala/FetchX#subdirectory=clients/python-sdk"
```

```python
from fetchx import FetchX

fx = FetchX()  # FETCHX_TOKEN (an fxk_ key) from the environment; FETCHX_URL when set
result = fx.fetch(url="https://shop.example.com/p/42", formats=["markdown"])
if result.ok:
    print(result.markdown, result.credits, result.step)
else:
    print(result.error_code, result.next_action, result.retry_with_new_key)
```

`FetchX(base_url, token)` takes them directly too. `FETCHX_API_KEY` works in place of `FETCHX_TOKEN`, and `node clients/connect.mjs -- python my_crawler.py` sets both variables after a user approves a project (see [the clients guide](../README.md)).

## Requests and results

A request is a `POST /v1/fetch` body, given as a dict, as keyword fields, or both: `fx.fetch({"url": url}, max_credits=60)`. Use `async_=True` for the `async` field. Every field in the [API guide](https://fetchx.ai/docs) works: `formats`, `expect`, `extract`, `scroll`, `render`, `country`, `tags` and the rest.

`fetch()` returns a `FetchResult` whether the request succeeded or failed:

| Property | What it is |
| --- | --- |
| `ok`, `failed`, `pending`, `status` | The outcome |
| `page_status` | `content`, `not_found`, `empty`, `challenge` or `error` |
| `markdown`, `text`, `links`, `metadata`, `skeleton`, `extract`, `screenshot` | What `formats` and `extract` asked for (`skeleton`: the shape of a JSON body, or None) |
| `body`, `content` | The site's body as text and as bytes, when it was asked for (see below) |
| `source_status`, `final_url`, `content_type`, `headers`, `cookies`, `rendered` | What the site answered |
| `next_page`, `page` | How the page leads on, and where it sits in a list |
| `network` | With `capture`: calls kept and dropped, and where to read them |
| `credits`, `credits_max`, `balance`, `breakdown`, `step` | What it cost and which step got it |
| `error`, `error_code`, `next_action`, `retry_with_new_key`, `retry_after_seconds` | Why it failed and what to do |
| `challenge`, `attempts`, `skipped`, `fixes` | The walls it met and the route it took |
| `id`, `idempotency_key`, `url`, `tags`, `created_at`, `finished_at` | The request |

Every result also reads like the JSON it came from (`result["data"]["markdown"]`, `result.get("error")`, `result.raw`), so fields FetchX adds later are there before they get a property. `summary()` gives a compact dict for logs and `raise_for_status()` raises `FetchFailed` unless it succeeded.

**Bodies.** The body comes back when `formats` asks for `body`, which is the default when `formats` is left out. When it is not inline (after polling, or a large or binary body) the client downloads it from `/v1/fetch/{id}/content`. `want_body=True` downloads it even when `formats` did not ask, and `want_body=False` never does. Set the default for every call with `FetchX(want_body=...)`.

## What the client does for you

- **Waiting.** FetchX answers within 60 seconds or with 202. `fetch()` and `next()` then poll `GET /v1/fetch/{id}` every `poll_every` seconds (3) for up to `max_wait` (600). Past that they raise `wait_timeout` with the id in `details`; the request goes on running, so read it later with `wait(id)`. A request with `async` set comes back pending at once.
- **Safe resends.** Every request that starts work carries an `idempotency_key`, generated when you leave it out. After a lost answer, a 429 or a 502, 503 or 504 (maintenance included), the same body is sent again with the same key after each of `unavailable_waits` (2, 5, 15, 30, 60 and 120 seconds), or after FetchX's `Retry-After` when it gives one. FetchX returns the first result for a key and never charges twice, so this is safe. `extract_unavailable` is not resent.
- **Refusals raise, failures return.** A refused call (4xx) raises `FetchXError` with `code`, `status`, `details` and `retry_after_seconds`; nothing was sent to the site or charged. A fetch that ran and failed is returned, and `error.next` says what to do. A key replays its first result, failures included, so a retry needs a new key, and only helps when `retry_with_new_key` is true. `FetchX(retry_failed=2)` does that for you: it sends the request again as `<key>.retry1`, `<key>.retry2` after `retry_after_seconds`, and leaves waits over `max_retry_wait` (900 seconds) to you.
- **One request at a time per site.** Single fetches to the same site (the host without `www.`) take turns, also across threads and tasks; other sites run alongside. `per_site=2` allows two, `per_site=None` turns it off. Batches are paced by FetchX itself.
- **Credit caps.** `FetchX(max_credits=60)` caps every request, next page and batch item that sets no `max_credits` of its own. `FetchX(spend_limit=5000)` caps what this client may spend in total: each request's `max_credits` is lowered to what is left, credits that running requests may still cost are held, and a call that would pass the limit raises `SpendLimitReached` before anything is sent. Under a spend limit every batch item needs a `max_credits`, so the batch's most possible cost is known before it is submitted. `credits_spent`, `calls` and `remaining_credits` say where the client stands. With a spend limit and several requests at once, set `max_credits` too, so each request holds only its own cap.
- **A hook on every call.** `FetchX(on_call=log_call)` calls `log_call(event)` after each call with a `CallEvent`: `op`, `ok`, `fetch_id`, `batch_id`, `url`, `idempotency_key`, `status`, `page_status`, `credits`, `step`, `error_code`, `next_action`, `raised` (the error code when the call raised), `http_status`, `requests`, `resends`, `polls` and `elapsed`. A hook that raises is logged, never raised.

The client never follows redirects, ignores proxy settings from the environment, and never puts the API key in an error or a log line. Pass `http_client=httpx.Client(...)` to use your own proxies or limits.

## Next pages

```python
page = fx.fetch(url="https://shop.example.com/search?q=lamp", formats=["markdown"])
pages = [page]
while page.has_next_page and len(pages) < 5:
    page = fx.next(page)          # or fx.next(page.id, scroll=20, max_credits=60)
    pages.append(page)
```

Each next page is a new request with its own id, key, `next_page` and charge, on the earlier request's site slot.

## The page's own network calls

`capture=True` (or a dict of settings: `types`, `max_requests`, `max_body_bytes`, `bodies`, `first_party_only`, `include_trackers`, `unmask`) has a browser record the calls the page makes, with their headers and bodies. Use `contains` to find the call that carries a value the page shows:

```python
result = fx.fetch(url="https://shop.example.com/search?q=lamp", capture=True)
found = fx.network(result, contains=["Lamp", "19.99"], content_type="json")
call = fx.network_call(result, found.items[0]["index"])
print(call.url, call.body)                   # the JSON the page was built from
har = fx.network_har(result)                 # for browser developer tools
```

`network()` returns a `NetworkPage` (`items`, `next_cursor`, `network`), `network_call()` a `NetworkCall` (`request`, `response`, `url`, `body`) and `network_body()` the raw `Content` of a body too large to return inline. Secret headers come back masked unless the request set `unmask`. A next page keeps `capture` unless it passes `capture=None`.

## Batches

```python
results = fx.run_batch(urls, defaults={"formats": ["markdown"], "expect": {"text": "Price"}},
                       idempotency_key="catalog-2026-11-23")
for url, result in zip(urls, results):
    print(url, result.status if result else "never ran")
```

`run_batch` submits up to 1000 URLs or fetch bodies, waits for the batch and returns one result per item in order (None for an item refused before it started). For more control: `submit_batch()` returns at once, `batch_results(batch_id)` yields each item as it finishes, `wait_batch()`, `batch()`, `batch_items()`, `cancel_batch()` and `list_batches()`. Items must not set `idempotency_key`, `async` or `webhook_url`, since FetchX keys and paces each item itself; the client refuses such a batch before sending it. `max_credits` in `defaults` caps each item.

## Cost and account

`estimate()` takes a fetch body or a batch body and says what it would cost and take, without sending or reserving anything: `estimate.credits.expected`, `.typical`, `.high`, `estimate.covers_expected`, and per item `basis` and `notes`. `balance()`, `usage(period="day")` and `status()` read the account and the service. `me()` says which project and key are calling (`project_id`, `key_id`, `key_name`, `key_prefix`, `scopes`) and the key's `limits` (credits per day and month with what is used and left, and `expires_at`); any valid key may call it, and `project_id` stays the same when the key is rotated. A request over a key's limit raises `FetchXError` with code `key_limit_reached` (402, not resent). `send_feedback(fetch_id=result.id, kind="blocked_via_fetchx_ok_from_home", evidence={...})` reports a page FetchX could not get or got wrong (or `url=` instead of `fetch_id=`); `get_feedback(report)` returns its `status` and staff's `reply`. `FakeFetchX` keeps reports in `fake.feedback`, and `fake.answer_feedback(id, "resolved", "reply")` plays the staff side.

## Asyncio

`AsyncFetchX` has the same options and methods, to be awaited; `batch_results` is an async iterator.

```python
import asyncio
from fetchx import AsyncFetchX

async def main(urls):
    async with AsyncFetchX(max_credits=60) as fx:
        return await asyncio.gather(*(fx.fetch(url=url, formats=["markdown"]) for url in urls))
```

Requests to the same site still take turns, so a `gather` over many sites runs one request per site at a time.

## Tests without the network

`fetchx.testing.FakeFetchX` is an in-memory FetchX that answers in the shapes of the public contract, which this repository's tests hold it to: 202 and polling, key replay and conflicts, next pages, stored content and screenshots, network captures, batches, estimates, balance, usage, status and `me`, with credits on every result. It knows nothing about any real site: pages are what you give it, including the calls a page makes (`FakePage(..., network=[{"url": ".../api/items", "type": "xhr", "body": {...}}])`), which a request with `capture` then records.

```python
from fetchx.testing import FakeFetchX, FakePage

fake = FakeFetchX({"https://shop.example.com/p/1": FakePage("<html>Lamp</html>", next_url="https://shop.example.com/p/2"),
                   "https://shop.example.com/p/2": "<html>Desk</html>"}, pending_polls=1)
fake.fail("https://shop.example.com/p/3", "blocked", retry_after_seconds=900)
fake.unavailable(1, code="maintenance")      # the next call answers 503
fake.drop(1, method="POST")                  # the next POST runs, but its answer is lost

fx = fake.client()                           # or fake.async_client(); neither sleeps
assert fx.fetch(url="https://shop.example.com/p/1").ok
assert [r["url"] for r in fake.site_requests] == ["https://shop.example.com/p/1"]
```

`fake.requests` records every call the client made, `fake.site_requests` every request that reached the "site", and `fake.peak_running` the most requests running at once per site. `refuse(status, code)` answers with any error, `FetchX(transport=fake.transport())` wires a client of your own.

## Methods

| Endpoint | `FetchX` and `AsyncFetchX` |
| --- | --- |
| `POST /v1/fetch` | `fetch(body, **fields)` (waits) |
| `POST /v1/fetch/{id}/next` | `next(previous, **fields)`, also `next_page` |
| `GET /v1/fetch/{id}` | `get(id)`, `get_raw(id)`, `wait(id)` |
| `GET /v1/fetch` | `list(status=, tag=, idempotency_key=, since=, limit=, cursor=)` |
| `GET /v1/fetch/{id}/content` | `content(id)` |
| `GET /v1/fetch/{id}/screenshot` | `screenshot(id)` |
| `GET /v1/fetch/{id}/network` | `network(id, type=, content_type=, host=, first_party=, status=, page=, phase=, contains=, limit=, cursor=)` |
| `GET /v1/fetch/{id}/network/{index}` | `network_call(id, index)` |
| `GET /v1/fetch/{id}/network/{index}/body` | `network_body(id, index)` |
| `GET /v1/fetch/{id}/network.har` | `network_har(id, page=)` |
| `DELETE /v1/fetch/{id}` | `delete(id)` |
| `POST /v1/batches` | `submit_batch(items, defaults=, idempotency_key=, tags=, webhook_url=)`, `run_batch(...)` |
| `GET /v1/batches/{id}` | `batch(id)`, also `get_batch`, `wait_batch(id)` |
| `GET /v1/batches` | `list_batches(status=, limit=, cursor=)` |
| `GET /v1/batches/{id}/items` | `batch_items(id, ...)`, `batch_results(id)` |
| `POST /v1/batches/{id}/cancel` | `cancel_batch(id)` |
| `POST /v1/estimate` | `estimate(body, **fields)` |
| `GET /v1/balance` | `balance()` |
| `GET /v1/usage` | `usage(period=, since=, until=)` |
| `GET /v1/status` | `status()` |
| `GET /v1/me` | `me()` |
| `POST /v1/feedback` | `send_feedback(body, **fields)` |
| `GET /v1/feedback/{id}` | `get_feedback(id)` |

## The single-file client

[`clients/python.py`](../python.py) stays as it is: one file to copy, returning the API's JSON as dicts, as used in the website's examples. This package is for applications and crawlers that want the rules above handled. Its results read like those dicts (`result["status"]`, `content["body"]`), and the method names match where the endpoints are the same.

## Developing

The tests live with the platform's other Python tests and run offline:

```sh
python -m pip install httpx
python -m unittest discover -s test -p 'python_sdk_*test.py'
```

`test/python_sdk_contract_test.py` checks every request the SDK sends and every answer the fake gives against `docs/openapi.json`, so a contract change that the SDK or the fake misses fails there.
