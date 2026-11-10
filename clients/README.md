# FetchX clients

## Connect a coding agent

On a deployment with FetchX Connect enabled, use Node.js 24 to run a command with an approved project's credentials in the command's environment.

```sh
node clients/connect.mjs -- codex
```

You can use your existing DeepSeek harness command or run a specific workload in place of `codex`. Share the displayed link and short code with the user. Codex can open the link in its in-app browser for the user. With a browserless agent, the user opens it in a regular browser. The user signs in, enters the short code and approves a project within ten minutes. Keep that Connect process running while they approve.

The wrapper launches the command with `FETCHX_URL` and `FETCHX_TOKEN` in its environment. The wrapped command must keep `FETCHX_TOKEN` private and use it only for requests to `FETCHX_URL`. If the agent is already running, use the wrapper around the workload it launches or call the helper in the process that will use the token.

```js
import { connectFetchX } from './connect.mjs';

const { token, apiBaseUrl } = await connectFetchX({
  clientName: 'My coding agent',
  onApproval: ({ verificationUri, userCode }) => {
    console.error(`Open ${verificationUri}\nFetchX code: ${userCode}`);
  },
});
const profiles = await fetch(`${apiBaseUrl}/v2/access-profiles`, {
  headers: { Authorization: `Bearer ${token}` },
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
if (!profiles.ok) throw new Error(`Could not list FetchX profiles (${profiles.status})`);
const { access_profiles } = await profiles.json();
```

The hosted helper is published as [connect-client.mjs](https://fetchx.ai/connect-client.mjs) when the corresponding website is deployed. For a verified self-hosted deployment, pass `--origin` (helper option `origin`) and, if the gateway uses a different origin, `--api-origin` (helper option `apiOrigin`). Use HTTPS except on loopback for local testing. If Connect is unavailable or your runtime cannot keep a process open for approval, provision a scoped project key and set `FETCHX_TOKEN` and `FETCHX_URL` through the runtime's private secret settings.

## JavaScript and Python API clients

See [API documentation](../docs/api.md). JavaScript exports `FetchXClient` and the compatible `GatewayClient`. Python exports the same names and requires `httpx`. Persist idempotency keys before dispatch; use `lookupFetch` / `lookup_fetch` after losing a response. Clients never retry a source automatically.

```js
import {FetchXClient} from './javascript.mjs';
const client = new FetchXClient({url: process.env.FETCHX_URL, token: process.env.FETCHX_TOKEN});
const result = await client.fetchPage({profile: 'example.http', url: 'https://example.com/', idempotency_key: 'saved-job-key'});
console.log(result.status);
```
