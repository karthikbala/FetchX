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
console.log((await fetchx.usage()).balance);
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
| `GET /v1/fetch/{id}` | `get(id, {includeBody})`, `wait(id)` | `get(id, include_body=)`, `wait(id)` | `fetch:read` |
| `GET /v1/fetch` | `list(query)` | `list(...)` | `fetch:read` |
| `GET /v1/fetch/{id}/content` | `content(id)` | `content(id)` | `fetch:read` |
| `GET /v1/fetch/{id}/screenshot` | `screenshot(id)` | `screenshot(id)` | `fetch:read` |
| `DELETE /v1/fetch/{id}` | `delete(id)` | `delete(id)` | `fetch:read` |
| `GET /v1/usage` | `usage(query)` | `usage(...)` | `usage:read` |

## Outcomes, errors and retries

A fetch that ran returns its result whether it succeeded or not: check `status`. A failed result has `error.code`, a one-line `error.message` and `error.next` (an `action` and a `detail`) that an agent can act on, and `data` holds what the site last answered. A pending result (`async: true`, or longer than 60 seconds) comes back with `status: 'pending'`; `wait(id)` polls until it finishes.

A refused call (4xx) throws `FetchXError` with `code`, `status`, `details` and `retryAfterSeconds` (`retry_after_seconds` in Python). Nothing was sent to the site and nothing was charged.

`fetch` always sends an `idempotency_key`, generated when you leave it out. After a lost response, a `429` or a `503` it resends the same body with the same key up to `retries` times (default 2). FetchX returns the first result for a key and never charges twice, so a resend is safe. Keep the key with your own record of the request if you need to find it later with `list({idempotency_key})`.
