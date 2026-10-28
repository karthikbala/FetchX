# FetchX clients

See [API documentation](../docs/api.md). JavaScript exports `FetchXClient` and the compatible `GatewayClient`. Python exports the same names and requires `httpx`. Persist idempotency keys before dispatch; use `lookupFetch` / `lookup_fetch` after losing a response. Clients never retry a source automatically.

```js
import {FetchXClient} from './javascript.mjs';
const client = new FetchXClient({url: process.env.FETCHX_URL, token: process.env.FETCHX_TOKEN});
const result = await client.fetchPage({profile: 'example.http', url: 'https://example.com/', idempotency_key: 'saved-job-key'});
console.log(result.status);
```
