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

Both clients export `FetchXClient` and the compatible `GatewayClient` name.
JavaScript runs on Node.js and includes TypeScript types for the public v2 API,
generated from the [OpenAPI contract](../docs/openapi.json). Python requires
`httpx`. Both clients send project Bearer credentials to your gateway.

Use the examples from the repository root. Replace the example URL and profile
references with approved values. Persist each caller key with its request before
submission so you can recover it after a lost response.

```js
import {FetchXClient} from './clients/javascript.mjs';

const client = new FetchXClient({url: process.env.FETCHX_URL, token: process.env.FETCHX_TOKEN});
const fetched = await client.fetchV2({
  idempotency_key: 'quickstart-001',
  access_profile: {id: 'source.http', version: 1},
  url: 'https://source.example/data',
  proxy: {class: 'direct', country: null},
});
console.log(fetched.success, fetched.data?.status, fetched.retry.next_action);

const capabilities = await client.capabilitiesV2();
if (capabilities.features.browser_render) {
  const rendered = await client.renderV2({
    idempotency_key: 'render-001',
    access_profile: {id: 'source.browser', version: 1},
    url: 'https://source.example/',
    proxy: {class: 'direct', country: null},
    screenshot: true,
    wait_ms: 500,
  });
  console.log(rendered.success, rendered.data?.status, rendered.retry.next_action);
}
```

```python
import os

from clients.python import FetchXClient

client = FetchXClient(os.environ['FETCHX_URL'], os.environ['FETCHX_TOKEN'])
fetched = client.fetch_v2(
    idempotency_key='quickstart-001',
    access_profile={'id': 'source.http', 'version': 1},
    url='https://source.example/data',
    proxy={'class': 'direct', 'country': None},
)
print(fetched['success'], (fetched['data'] or {}).get('status'), fetched['retry']['next_action'])

capabilities = client.capabilities_v2()
if capabilities['features']['browser_render']:
    rendered = client.render_v2(
        idempotency_key='render-001',
        access_profile={'id': 'source.browser', 'version': 1},
        url='https://source.example/',
        proxy={'class': 'direct', 'country': None},
        screenshot=True,
        wait_ms=500,
    )
    print(rendered['success'], (rendered['data'] or {}).get('status'), rendered['retry']['next_action'])
```

## v2 methods and access

| Use | JavaScript | Python | Managed key scope |
| --- | --- | --- | --- |
| Submit native HTTP | `fetchV2` | `fetch_v2` | `fetch:write` |
| Submit an approved browser navigation | `renderV2` | `render_v2` | `fetch:write` |
| Recover Fetch or Render by the caller key | `lookupFetchV2`, `lookupRenderV2` | `lookup_fetch_v2`, `lookup_render_v2` | `fetch:read` |
| Read the Fetch projection by operation ID | `readFetchOperationV2` | `read_fetch_operation_v2` | `fetch:read` |
| Read capabilities, access profiles, and recipes | `capabilitiesV2`, `accessProfilesV2`, `recipesV2` | `capabilities_v2`, `access_profiles_v2`, `recipes_v2` | `profiles:read` |
| Read operation metadata, history, and artifacts | `readOperationV2`, `lookupOperationV2`, `recentOperationsV2`, `artifactV2` | `read_operation_v2`, `lookup_operation_v2`, `recent_operations_v2`, `artifact_v2` | `fetch:read` |
| Read usage | `usageV2` | `usage_v2` | `usage:read` |

`features.browser_render` reports configured Render availability for the project.
Render admission also checks the browser profile, destination, route, and
entitlement. Use the browser profile issued for the selected URL when working
with a managed account. See the [Fetch guide](../docs/fetch-api.md) and
[Render guide](../docs/render-api.md) for request and response behavior.

Both clients also cover the provisioned native v2 API. The JavaScript methods
`discoveryProfileV2`, `sessionV2`, `readSessionV2`, `operationV2`, and
`browserProbeV2` correspond to Python's `discovery_profile_v2`, `session_v2`,
`read_session_v2`, `operation_v2`, and `browser_probe_v2`. These native endpoints
require a provisioned project token and the applicable profile and runtime
policies. See the [native v2 API guide](../docs/api-v2.md).

## Handle outcomes and recover

The SDK returns the envelope on HTTP 200, including a retained source denial or
an unfinished operation with `success: false`. Check `success`, `data.status`,
and `retry.next_action` before using captured data. Validate application content
separately.

For a gateway HTTP error, `GatewayError` exposes `code`, the gateway `status`,
and the decoded JSON `response` when available. Use `operation_id`, `session_id`,
`retry`, and `diagnostics` for recovery context when present. The caller's
`idempotency_key` is available after transport loss, invalid JSON, or a gateway
error. Error strings contain the error code. Choose individual fields for logs
because the response can contain retained data.

After a lost response, use `lookupFetchV2(key)` or `lookup_fetch_v2(key)` for
Fetch, and `lookupRenderV2(key)` or `lookup_render_v2(key)` for Render. These
read-only requests recover the saved operation. Follow its recovery guidance
before considering further source work. Each v2 SDK call sends at most one
gateway request and surfaces gateway redirects as errors.

Existing v1 workflows, jobs, and Fetch helpers remain available for provisioned
tokens. Use `fetchPage` / `fetch_page` to submit v1 Fetch and `lookupFetch` /
`lookup_fetch` to recover it. See the [v1 API guide](../docs/api.md).
