export type DocSnippet = {
  label: string;
  language: 'bash' | 'javascript' | 'python' | 'json';
  code: string;
};

export type DocBlock =
  | { kind: 'text'; text: string }
  | { kind: 'note'; title: string; text: string }
  | { kind: 'code'; title: string; snippets: DocSnippet[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'link'; label: string; href: string };

export type DocSection = {
  id: string;
  title: string;
  blocks: DocBlock[];
};

export type DocPage = {
  slug: string;
  title: string;
  description: string;
  group: 'Getting started' | 'API reference' | 'Guides';
  method?: 'GET' | 'POST';
  endpoint?: string;
  sections: DocSection[];
};

const fetchRequest = `{
  "idempotency_key": "quickstart-001",
  "access_profile": { "id": "source.http", "version": 1 },
  "url": "https://source.example/data",
  "proxy": { "class": "direct", "country": null }
}`;

const fetchSnippets: DocSnippet[] = [
  {
    label: 'cURL',
    language: 'bash',
    code: `curl --silent --show-error "$FETCHX_URL/v2/fetch" \\
  -H "Authorization: Bearer $FETCHX_TOKEN" \\
  -H 'Content-Type: application/json' \\
  --data-binary @fetch-request.json`,
  },
  {
    label: 'JavaScript',
    language: 'javascript',
    code: `import { readFile } from 'node:fs/promises';

const body = await readFile('fetch-request.json', 'utf8');
const response = await fetch(process.env.FETCHX_URL + '/v2/fetch', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + process.env.FETCHX_TOKEN,
    'Content-Type': 'application/json',
  },
  body,
});
const result = await response.json();
console.log(JSON.stringify(result, null, 2));

if (!response.ok || !result.success) {
  console.error(result.error?.code, result.retry?.next_action);
  process.exitCode = 1;
}`,
  },
  {
    label: 'Python',
    language: 'python',
    code: `import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen

with open("fetch-request.json", "rb") as file:
    body = file.read()

request = Request(
    os.environ["FETCHX_URL"] + "/v2/fetch",
    data=body,
    headers={
        "Authorization": "Bearer " + os.environ["FETCHX_TOKEN"],
        "Content-Type": "application/json",
    },
    method="POST",
)
try:
    response = urlopen(request, timeout=90)
except HTTPError as error:
    response = error

with response:
    result = json.load(response)
print(json.dumps(result, indent=2))
if not result.get("success"):
    print(result.get("error"), result.get("retry"))`,
  },
];

const recoverySnippets: DocSnippet[] = [
  {
    label: 'cURL',
    language: 'bash',
    code: `curl --silent --show-error "$FETCHX_URL/v2/fetch/quickstart-001" \\
  -H "Authorization: Bearer $FETCHX_TOKEN"`,
  },
  {
    label: 'JavaScript',
    language: 'javascript',
    code: `const key = 'quickstart-001';
const response = await fetch(
  process.env.FETCHX_URL + '/v2/fetch/' + encodeURIComponent(key),
  { headers: { Authorization: 'Bearer ' + process.env.FETCHX_TOKEN } },
);
const result = await response.json();
console.log(JSON.stringify(result, null, 2));`,
  },
  {
    label: 'Python',
    language: 'python',
    code: `import json
import os
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

key = "quickstart-001"
request = Request(
    os.environ["FETCHX_URL"] + "/v2/fetch/" + quote(key, safe=""),
    headers={"Authorization": "Bearer " + os.environ["FETCHX_TOKEN"]},
)
try:
    response = urlopen(request, timeout=90)
except HTTPError as error:
    response = error
with response:
    print(json.dumps(json.load(response), indent=2))`,
  },
];

const responseExample = `{
  "success": true,
  "state": "completed",
  "gateway_http_status": 200,
  "operation_id": "00000000-0000-4000-8000-000000000001",
  "session_id": "00000000-0000-4000-8000-000000000002",
  "idempotency_key": "quickstart-001",
  "routing": { "class": "direct", "country": null, "provider": "direct" },
  "data": {
    "status": 200,
    "final_url": "https://source.example/data",
    "content_type": "text/plain; charset=utf-8",
    "body_base64": "b2s=",
    "text": "ok",
    "retry_after": null
  },
  "error": null,
  "retry": {
    "safe_to_retry": false,
    "same_key_replay_safe": true,
    "new_request_allowed": false,
    "next_action": "complete",
    "lookup_url": "/v2/fetch/quickstart-001"
  },
  "application_acceptance": "not_evaluated"
}`;

export const docPages: DocPage[] = [
  {
    slug: '',
    title: 'Quickstart',
    description: 'Fetch your first approved URL, read the response and recover a saved result.',
    group: 'Getting started',
    sections: [
      {
        id: 'before-you-start',
        title: 'Start with your project',
        blocks: [
          { kind: 'text', text: 'FetchX provides a project-scoped gateway for HTTP fetching and reviewed collection workflows. On a service with account access enabled, sign up or log in, verify your email with its one-time code, create a project, then create a scoped `fxk_` API key. Your service supplies its gateway URL and operator-approved source profiles.' },
          { kind: 'note', title: 'Gateway availability', text: 'Confirm that account access and the v2 HTTP fetch API are enabled on your service. Use its supplied gateway endpoint for API calls. Existing provisioned project tokens remain usable with their approved API versions and profiles.' },
          { kind: 'text', text: 'For this walkthrough, grant `profiles:read` to list approved profiles, `fetch:write` to submit native HTTP requests and `fetch:read` to recover saved results. Add `usage:read` if your integration reads usage. New account keys support native HTTP; provisioned v1 and browser workflow contracts retain their existing behavior.' },
          { kind: 'link', label: 'Account access, key scopes and rotation', href: '/docs/authentication' },
          { kind: 'link', label: 'Using a v1 gateway? Start with workflow fetch', href: '/docs/workflow-fetch' },
          { kind: 'code', title: 'Set your environment', snippets: [{ label: 'Shell', language: 'bash', code: `export FETCHX_URL='https://YOUR_PROVISIONED_ENDPOINT'
export FETCHX_TOKEN='YOUR_PROJECT_API_KEY_OR_TOKEN'` }] },
          { kind: 'text', text: 'Use the base URL without a trailing slash. `FETCHX_TOKEN` accepts your new API key or an existing provisioned project token. Copy a new key when it is revealed once, and keep it in your server environment or secret store. The examples use cURL, native Node.js fetch and the Python standard library.' },
        ],
      },
      {
        id: 'find-a-profile',
        title: '1. Find an approved profile',
        blocks: [
          { kind: 'code', title: 'List access profiles', snippets: [{ label: 'cURL', language: 'bash', code: `curl --silent --show-error "$FETCHX_URL/v2/access-profiles" \\
  -H "Authorization: Bearer $FETCHX_TOKEN"` }] },
          { kind: 'text', text: 'Choose an entry from `access_profiles`. Copy its exact `id` and `version`, then select a URL, method and route permitted by that profile. Account creation and key scopes do not grant additional source access. `route_reservations` shows the reviewed route combinations and their reservation estimates.' },
          { kind: 'link', label: 'Read the access profile reference', href: '/docs/profiles' },
        ],
      },
      {
        id: 'save-your-request',
        title: '2. Save your request',
        blocks: [
          { kind: 'text', text: 'Save the following JSON as `fetch-request.json`. Replace the example profile ID, version and destination with values approved for your project. This example requires a profile that permits the `direct` route. For an approved proxy route, supply its class and uppercase country instead.' },
          { kind: 'code', title: 'fetch-request.json', snippets: [{ label: 'JSON', language: 'json', code: fetchRequest }] },
          { kind: 'text', text: 'Persist the request and its `idempotency_key` before dispatch. Use one key per intended source operation. Keep the same key and identical request to recover from a lost response. Save a distinct key when you deliberately create a new operation.' },
        ],
      },
      {
        id: 'send-the-request',
        title: '3. Send the request',
        blocks: [
          { kind: 'text', text: 'Each example reads the saved JSON file and makes one request. Run the JavaScript example as an ES module, such as `fetch-example.mjs`.' },
          { kind: 'code', title: 'POST /v2/fetch', snippets: fetchSnippets },
        ],
      },
      {
        id: 'read-the-response',
        title: '4. Check the result',
        blocks: [
          { kind: 'text', text: 'This illustrative response excerpt shows the main result fields. FetchX also returns retained artifact metadata, diagnostics and usage. Check `success`, `state`, `data.status` and `error`, then validate the returned content against your application requirements.' },
          { kind: 'code', title: 'Successful response excerpt', snippets: [{ label: 'JSON', language: 'json', code: responseExample }] },
          { kind: 'note', title: 'Two status levels', text: '`gateway_http_status` describes the API response. `data.status` describes the source website. A retained source 403 can arrive in an API HTTP 200 response with `success: false`. `application_acceptance` remains `not_evaluated`.' },
          { kind: 'link', label: 'Explore the fetch request and response fields', href: '/docs/fetch' },
        ],
      },
      {
        id: 'recover-your-result',
        title: '5. Recover by key',
        blocks: [
          { kind: 'text', text: 'If your connection drops, read the saved result using the original idempotency key and an active credential for the same project. An account API key needs `fetch:read`. This lookup reads retained evidence without fetching the source again. Inspect the returned state and `retry.next_action` before considering further work.' },
          { kind: 'note', title: 'Credits and uncertain outcomes', text: 'Account requests use conservative credit reservations within operator-approved limits. An unknown result retains its hold. Do not automatically retry unknown source work or submit a new operation key to bypass it; recover the original result first. Customer credits are separate from provider invoices.' },
          { kind: 'code', title: 'GET /v2/fetch/:idempotency_key', snippets: recoverySnippets },
          { kind: 'link', label: 'Understand idempotency and recovery', href: '/docs/recovery' },
        ],
      },
    ],
  },
  {
    slug: 'authentication',
    title: 'Authentication',
    description: 'Use verified account access and scoped API keys, or an existing provisioned project token.',
    group: 'Getting started',
    sections: [
      {
        id: 'base-url',
        title: 'Your gateway URL',
        blocks: [
          { kind: 'text', text: 'Use the gateway base URL supplied by your service or FetchX operator and confirm its enabled API version. Set `FETCHX_URL` to that URL without a trailing slash. The examples use a placeholder hostname that you replace with your supplied endpoint.' },
          { kind: 'note', title: 'Source access is approved per project', text: 'Your token identifies a project. Its profiles define the source URLs, methods, headers, routes, countries and usage limits available to you. Contact your FetchX operator to request an additional source or capability.' },
        ],
      },
      {
        id: 'account-access',
        title: 'Verify your account and create a project',
        blocks: [
          { kind: 'text', text: 'On a service with account access enabled, signup and login use a one-time email verification code. Verify your email, create a project, then create an API key with the scopes your integration needs. Creating a project grants your verified account membership in it; project policies and source profiles come only from the operator-approved template.' },
          { kind: 'text', text: 'The website uses an HttpOnly session cookie through its same-origin bridge. Website JavaScript does not receive the session token. Signing out revokes that session. API integrations authenticate separately with a project API key in the Bearer header.' },
          { kind: 'note', title: 'Native HTTP account keys', text: 'New `fxk_` account keys authorize the supported native HTTP API within their scopes. They do not authorize v1 workflows or browser execution. Existing provisioned project tokens keep their approved v1, v2 and browser contracts.' },
        ],
      },
      {
        id: 'bearer-token',
        title: 'Send a Bearer token',
        blocks: [
          { kind: 'text', text: 'Authenticated API routes require the `Authorization` header on every request. Use TLS for remote access and keep tokens in a server environment or secret store.' },
          { kind: 'code', title: 'Authenticated request', snippets: [{ label: 'cURL', language: 'bash', code: `curl --silent --show-error "$FETCHX_URL/v2/access-profiles" \\
  -H "Authorization: Bearer $FETCHX_TOKEN"` }] },
          { kind: 'text', text: 'Set `FETCHX_TOKEN` to your scoped API key or existing provisioned project token. A missing, expired or revoked credential returns HTTP `401`; an account key without the required route scope returns HTTP `403` with `api_key_scope_forbidden`. Check the credential, project and gateway URL before resending.' },
          { kind: 'table', headers: ['Account key scope', 'Access'], rows: [
            ['`profiles:read`', 'Read approved access profiles, capabilities and recipes.'],
            ['`fetch:write`', 'Submit native HTTP requests with `POST /v2/fetch`.'],
            ['`fetch:read`', 'Read saved fetch results, request history and retained artifacts.'],
            ['`usage:read`', 'Read project usage with `GET /v2/usage`.'],
          ] },
          { kind: 'text', text: 'Scopes limit API actions; they do not expand approved destinations, methods, routes or spending limits. Source website credentials have a separate approved header scope. Gateway API keys and session tokens are forbidden in source request headers or browser input values.' },
        ],
      },
      {
        id: 'key-lifecycle',
        title: 'Create, rotate and revoke keys',
        blocks: [
          { kind: 'text', text: 'A new API key is revealed once at creation or rotation. Copy it into your server secret store; the service stores its hash and cannot reveal the token again. Key lists contain metadata and a short prefix.' },
          { kind: 'text', text: 'Rotation atomically creates a replacement and revokes the previous key. Revocation removes further access immediately. Update your integration with the replacement token; saved results remain attached to the project and can be read with another active key that has `fetch:read`.' },
          { kind: 'text', text: 'Customer credits are reserved conservatively and remain held for unknown source outcomes. Key rotation or revocation does not clear a hold or authorize a new source attempt. Recover the original operation rather than automatically retrying uncertain work.' },
        ],
      },
      {
        id: 'project-isolation',
        title: 'Project isolation',
        blocks: [
          { kind: 'text', text: 'Profiles, source sessions, operations, idempotency keys, jobs and retained artifacts are scoped to the authenticated project. Website access requires membership in that project; API access requires an active credential for it. An identifier from another project grants no access to its data.' },
          { kind: 'text', text: 'Keep API keys out of application browser bundles, web storage, public repositories, screenshots and source request headers. The website reveals a newly issued key only for copying into your secret store. The gateway manages source cookies through its separate source session state.' },
          { kind: 'link', label: 'Choose an approved access profile', href: '/docs/profiles' },
        ],
      },
    ],
  },
  {
    slug: 'workflow-fetch',
    title: 'Workflow fetch',
    description: 'Fetch an approved source through the v1 API, including configured browser recipes.',
    group: 'API reference',
    method: 'POST',
    endpoint: '/v1/fetch',
    sections: [
      {
        id: 'choose-a-profile',
        title: 'Choose a v1 source profile',
        blocks: [
          { kind: 'text', text: 'The v1 fetch API runs one operation through a reviewed source profile and closes its workflow after capture. The profile selects the HTTP or browser execution mode, country, routing and limits. Your provisioned gateway and approved profiles determine availability.' },
          { kind: 'code', title: 'GET /v1/profiles', snippets: [{ label: 'cURL', language: 'bash', code: `curl --silent --show-error "$FETCHX_URL/v1/profiles" \\
  -H "Authorization: Bearer $FETCHX_TOKEN"` }] },
          { kind: 'text', text: 'Read `profiles` in the response. Each entry includes `id`, `execution`, `country`, `methods`, `recipes`, `captcha` and `max_response_bytes`. Copy the approved string ID into the request `profile` field. The v2 access profile object belongs to the separate v2 API.' },
        ],
      },
      {
        id: 'request-body',
        title: 'Request body',
        blocks: [
          { kind: 'text', text: 'Send your project Bearer token and JSON body. Replace the fictional profile and destination with approved project values, and persist the operation key before calling.' },
          { kind: 'code', title: 'POST /v1/fetch', snippets: [{ label: 'cURL', language: 'bash', code: `curl --silent --show-error "$FETCHX_URL/v1/fetch" \\
  -H "Authorization: Bearer $FETCHX_TOKEN" \\
  -H 'Content-Type: application/json' \\
  --data '{
    "profile": "source.http",
    "url": "https://source.example/data",
    "idempotency_key": "workflow-001"
  }'` }] },
          { kind: 'table', headers: ['Field', 'Required', 'Description'], rows: [
            ['`profile`', 'Yes', 'Approved v1 source profile ID as a string.'],
            ['`url`', 'Yes', 'HTTPS URL permitted by the selected source profile.'],
            ['`idempotency_key`', 'Yes', 'Durable key of 1–160 letters, digits, `_`, `.`, `:` or `-`.'],
            ['`method`', 'No', 'Defaults to `GET`. Must be approved by the profile.'],
            ['`headers`', 'No', 'Approved source header names and string values.'],
            ['`body_base64`', 'No', 'Canonical base64 body within the profile limit. GET and HEAD reject bodies.'],
            ['`main_document`', 'No', 'Defaults to true in this facade. Browser captures require true and GET.'],
            ['`resource_type`', 'No', 'Resource classification permitted by the reviewed workflow.'],
            ['`browser`', 'No', 'Approved `{ "recipe": "name", "values": { ... } }` input for a browser profile.'],
            ['`zipcode`', 'No', 'Six-digit postal value for explicitly configured legacy profiles that require it.'],
          ] },
        ],
      },
      {
        id: 'read-the-capture',
        title: 'Read the capture',
        blocks: [
          { kind: 'code', title: 'Illustrative response excerpt', snippets: [{ label: 'JSON', language: 'json', code: `{
  "id": "00000000-0000-4000-8000-000000000004",
  "workflow": "00000000-0000-4000-8000-000000000005",
  "status": 200,
  "provider_status": null,
  "country": "US",
  "headers": { "content-type": "text/plain; charset=utf-8" },
  "body_base64": "b2s=",
  "error": null,
  "fallback_blocked": null
}` }] },
          { kind: 'text', text: 'The complete capture also contains provider, timestamp and accounting metadata, plus browser details where relevant. `status` is the source HTTP status. `error` is a code string or null. Decode `body_base64` and validate the source content before accepting a record. API HTTP 200 indicates a retained capture is available.' },
          { kind: 'text', text: 'New residential captures can include `customer_traffic`, with an exact decimal `cost_usd` when measured. Failed attempts can consume traffic. Saved replay and lookup return the original capture and accounting.' },
        ],
      },
      {
        id: 'browser-recipes',
        title: 'Reviewed browser recipes',
        blocks: [
          { kind: 'text', text: 'Rendering is selected by an approved browser profile. Select a recipe advertised by that profile and supply only its declared text variables. Your onboarding specifies the accepted variable names and required outputs.' },
          { kind: 'code', title: 'Illustrative approved recipe input', snippets: [{ label: 'JSON', language: 'json', code: `{
  "profile": "catalog.browser",
  "url": "https://catalog.example/search",
  "idempotency_key": "catalog-search-001",
  "browser": {
    "recipe": "search",
    "values": { "query": "desk" }
  }
}` }] },
          { kind: 'text', text: 'Configured recipes can fill, select, click, press, wait and scroll using reviewed selectors. Results may contain `extracted`, `screenshot`, `actions_completed` and `action_step`. Captured fields still need application validation.' },
          { kind: 'note', title: 'Recover after browser uncertainty', text: 'Any recipe action other than waiting makes automatic provider replay unsafe. If a later response is denied, interrupted or uncertain, recover the original operation and review its progress before initiating new source work.' },
          { kind: 'text', text: 'Profiles advertising `captcha.async_required` use the asynchronous job API.' },
          { kind: 'link', label: 'Queue a reviewed v1 workflow', href: '/docs/jobs' },
        ],
      },
      {
        id: 'recover-by-key',
        title: 'Recover by key',
        blocks: [
          { kind: 'code', title: 'GET /v1/fetch/:key', snippets: [{ label: 'cURL', language: 'bash', code: `curl --silent --show-error "$FETCHX_URL/v1/fetch/workflow-001" \\
  -H "Authorization: Bearer $FETCHX_TOKEN"` }] },
          { kind: 'text', text: 'Identical requests with the same key return the original capture. Changed input under that key conflicts. Preserve the original key after a lost response and use this lookup. Keep distinct keys for synchronous fetches and queued jobs. Retention expiry requires review before any replacement source request.' },
          { kind: 'text', text: 'For approved multi-operation sessions, the native workflow API creates a workflow with `POST /v1/workflows` and performs operations at `/v1/workflows/:id/operations`. Cookies and retained browser storage are restored across operations according to the reviewed profile. Coordinate the full workflow contract during onboarding.' },
        ],
      },
    ],
  },
  {
    slug: 'fetch',
    title: 'Fetch a URL',
    description: 'Make one native HTTP request with an explicit profile, route and durable key.',
    group: 'API reference',
    method: 'POST',
    endpoint: '/v2/fetch',
    sections: [
      {
        id: 'request',
        title: 'Request body',
        blocks: [
          { kind: 'text', text: 'Send JSON with `Content-Type: application/json` and your project Bearer token. Replace this synthetic profile and URL with approved project values. The gateway creates an internal HTTP session when you omit `session_id`.' },
          { kind: 'code', title: 'Minimum request', snippets: [{ label: 'JSON', language: 'json', code: fetchRequest }] },
          { kind: 'table', headers: ['Field', 'Required', 'Description'], rows: [
            ['`idempotency_key`', 'Yes', '1–160 characters from letters, digits, `_`, `.`, `:` and `-`. Persist before calling.'],
            ['`access_profile`', 'Yes', 'Exact approved `{ "id": "source.http", "version": 1 }` reference.'],
            ['`url`', 'Yes', 'HTTPS URL permitted by the profile origins and paths.'],
            ['`proxy`', 'Yes', 'Explicit `{ "class": "direct", "country": null }` or an approved proxy class and country.'],
            ['`session_id`', 'No', 'Owned HTTP session UUID for cookie continuity. Its profile and route stay pinned.'],
            ['`method`', 'No', 'Defaults to `GET`. Supported methods are `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE`, subject to profile approval.'],
            ['`headers`', 'No', 'Object of approved source header names and string values. Defaults to `{}`.'],
            ['`body_base64`', 'No', 'Canonical base64 request body within the profile limit. GET and HEAD reject bodies.'],
            ['`max_estimated_micro_usd`', 'No', 'Nonnegative integer ceiling for the conservative reservation estimate. One USD equals 1,000,000 microdollars.'],
            ['`retry`', 'No', 'Boolean, default `false`. Permits at most one extra eligible fresh datacenter read attempt within the existing limits.'],
          ] },
          { kind: 'note', title: 'Native HTTP', text: 'This endpoint returns native source responses. Rendering, browser actions, screenshots, output `formats`, extraction options and arbitrary scripts return `capability_unsupported`. Unknown request fields are rejected.' },
        ],
      },
      {
        id: 'routing',
        title: 'Proxy class and country',
        blocks: [
          { kind: 'table', headers: ['Class', 'Country', 'Behavior'], rows: [
            ['`direct`', '`null`', 'Direct gateway connection. Its source country is unverified.'],
            ['`datacenter`', 'Approved uppercase code, such as `US`', 'Uses the configured datacenter pool for that country.'],
            ['`residential`', 'Approved uppercase code, such as `US`', 'Uses an available approved residential provider at session creation.'],
          ] },
          { kind: 'text', text: 'Select a route returned by the profile. Proxy country is requested routing configuration. Each session pins its provider, class and country. Reuse `session_id` for a later cookie-dependent request with a new operation key and the same profile and route.' },
          { kind: 'link', label: 'Inspect route reservations and profile limits', href: '/docs/profiles' },
        ],
      },
      {
        id: 'response',
        title: 'Response fields',
        blocks: [
          { kind: 'code', title: 'Illustrative response excerpt', snippets: [{ label: 'JSON', language: 'json', code: responseExample }] },
          { kind: 'table', headers: ['Field', 'Meaning'], rows: [
            ['`success`', 'True for a completed operation with a source 2xx response and no recognized challenge or gateway error.'],
            ['`state`', 'Durable operation state. Admission failures use `rejected`; uncertain outcomes use `unknown`.'],
            ['`gateway_http_status`', 'The gateway HTTP response status. Retained operations are returned with HTTP 200.'],
            ['`operation_id`, `session_id`', 'Project-owned operation and session UUIDs.'],
            ['`data.status`', 'Independent source HTTP status, or null when unavailable.'],
            ['`data.text`', 'Decoded text for supported textual MIME types and valid UTF-8 or ASCII. Otherwise null.'],
            ['`data.body_base64`', 'Final decoded native response body in base64, or null when unavailable.'],
            ['`artifacts`', 'Retained artifact IDs, status, hashes, encoded and decoded sizes, and decoding metadata.'],
            ['`error`', 'Null or a safe `{ code, message, stage }` error object.'],
            ['`diagnostics`', 'Retained stage and safe failure evidence, including attempt evidence when present.'],
            ['`retry`', 'Recovery location and guidance for any deliberate new source attempt.'],
            ['`usage`', 'Request and byte counts plus reservation, measurement and charge metadata.'],
            ['`application_acceptance`', '`not_evaluated`. Validate source identity, context and required fields in your application.'],
          ] },
          { kind: 'text', text: 'The gateway can retain a completed source error such as HTTP 403 and return `success: false` with API HTTP 200. Inspect the JSON result even when your HTTP client reports a successful API request.' },
        ],
      },
      {
        id: 'cost-and-usage',
        title: 'Cost ceilings and usage',
        blocks: [
          { kind: 'text', text: 'Read `route_reservations` on the approved profile before choosing a ceiling. An unavailable estimate returns `cost_estimate_unavailable` when a finite ceiling is supplied. A reservation above your ceiling returns `cost_ceiling_exceeded` before source dispatch.' },
          { kind: 'text', text: 'For residential traffic, the ceiling must cover both the provider estimate and the maximum customer traffic reservation. Read `customer_traffic_reservation.max_cost_usd` and `max_estimated_micro_usd` in the route quote. Usage can include failed-attempt traffic and supporting proxied DNS.' },
          { kind: 'text', text: 'Where present, `usage.accounting.customer_traffic.cost_usd` is an exact decimal string. `pending` or `unknown` charges retain a null cost. Reservation estimates, observed traffic and provider invoices have separate fields. Retained lookups and identical replays return the saved accounting for that operation.' },
        ],
      },
      {
        id: 'bounded-retries',
        title: 'Optional bounded retries',
        blocks: [
          { kind: 'text', text: 'For an eligible fresh cacheable GET or HEAD, set `retry: true` and omit `session_id`. At most one extra attempt can use another verified dedicated IP and endpoint in the same approved fixed-fee datacenter pool, class and country. Both attempts share the operation deadline, quota, byte and cost controls.' },
          { kind: 'text', text: 'Eligible failures are a proven proxy TCP refusal before a proxy request, an explicit CONNECT 502/503/504 rejection, or a complete source 502/503/504 response without cookies, a redirect, Retry-After or a recognized challenge. A distinct reviewed route and remaining allowance must be available.' },
          { kind: 'text', text: 'Source 403/404/429 responses, challenges, uncertain outcomes, incomplete bodies, state-changing requests, source credentials and sessions with cookies or prior work stop rotation. Direct and residential requests execute their normal single attempt.' },
          { kind: 'text', text: 'Opted-in results add `retry.requested`, `attempts`, `route_changed`, `effective_session_id` and `stop_reason`, plus `diagnostics.attempts`. Follow the saved recovery guidance after uncertainty.' },
          { kind: 'link', label: 'Read recovery and deliberate retry guidance', href: '/docs/recovery' },
        ],
      },
    ],
  },
  {
    slug: 'profiles',
    title: 'Access profiles',
    description: 'Discover the source destinations, routes and limits approved for your project.',
    group: 'API reference',
    method: 'GET',
    endpoint: '/v2/access-profiles',
    sections: [
      {
        id: 'list-profiles',
        title: 'List approved profiles',
        blocks: [
          { kind: 'text', text: 'Call this endpoint with your project token to retrieve `access_profiles`. Use an exact profile ID and version in every fetch request. Profile selection controls the permitted source access.' },
          { kind: 'code', title: 'Request', snippets: [{ label: 'cURL', language: 'bash', code: `curl --silent --show-error "$FETCHX_URL/v2/access-profiles" \\
  -H "Authorization: Bearer $FETCHX_TOKEN"` }] },
          { kind: 'code', title: 'Illustrative response excerpt', snippets: [{ label: 'JSON', language: 'json', code: `{
  "access_profiles": [
    {
      "id": "source.http",
      "version": 1,
      "origins": ["https://source.example"],
      "paths": ["^/data$"],
      "method_paths": null,
      "methods": ["GET"],
      "headers": ["accept"],
      "proxy_classes": ["direct"],
      "countries": [],
      "route_reservations": [
        {
          "class": "direct",
          "country": null,
          "provider": "direct",
          "reserved_tunnel_bytes": 0,
          "estimated_micro_usd": 0
        }
      ]
    }
  ]
}` }] },
          { kind: 'text', text: 'The excerpt uses fictional values and omits the full `limits` object. Your authenticated response is the source of truth for your project.' },
        ],
      },
      {
        id: 'profile-fields',
        title: 'Profile fields',
        blocks: [
          { kind: 'table', headers: ['Field', 'How to use it'], rows: [
            ['`id`, `version`', 'Copy both values into the fetch `access_profile` reference.'],
            ['`origins`', 'Choose an HTTPS destination within a listed origin.'],
            ['`paths`', 'Shared allowed path expressions, when present.'],
            ['`method_paths`', 'Additional per-method path restrictions, when present. A method without an entry is denied.'],
            ['`methods`', 'Permitted source HTTP methods.'],
            ['`headers`', 'Permitted source request header names, subject to credential restrictions.'],
            ['`proxy_classes`, `countries`', 'Approved route classes and requested proxy countries. Direct uses null country.'],
            ['`limits`', 'Request count, input/response size, tunnel bytes, timeout, redirects, pacing and session lifetime limits.'],
            ['`route_reservations`', 'Reviewed route combinations, provider availability and conservative estimates.'],
          ] },
          { kind: 'text', text: 'Destination, method and path checks also apply to redirects. A profile limits each session and operation. Project quotas and current route availability apply in addition to profile limits.' },
        ],
      },
      {
        id: 'route-reservations',
        title: 'Route reservations',
        blocks: [
          { kind: 'text', text: 'Each route quote includes `class`, `country`, `provider`, `reserved_tunnel_bytes` and `estimated_micro_usd`. Residential quotes can also include `customer_traffic_reservation`. Optional pricing metadata explains a saved traffic policy.' },
          { kind: 'note', title: 'Unknown estimates', text: 'A null provider or estimate means availability or pricing is unknown. Request a route review before relying on it. A zero incremental traffic estimate can have a separate subscription or unknown invoice amount.' },
          { kind: 'link', label: 'Use an approved profile in a fetch request', href: '/docs/fetch' },
        ],
      },
    ],
  },
  {
    slug: 'recovery',
    title: 'Idempotency and recovery',
    description: 'Recover retained work safely after a timeout, lost response or interrupted operation.',
    group: 'Guides',
    method: 'GET',
    endpoint: '/v2/fetch/:idempotency_key',
    sections: [
      {
        id: 'recover-by-key',
        title: 'Recover the original operation',
        blocks: [
          { kind: 'text', text: 'Persist a caller-generated key before `POST /v2/fetch`. If the response is lost, call the lookup endpoint using the same project token and original key. The lookup reconstructs the response from retained operations and captures without a new source request.' },
          { kind: 'code', title: 'Read a saved operation', snippets: recoverySnippets },
          { kind: 'text', text: 'The response uses the fetch envelope, including `state`, `data`, `error`, `retry` and `usage`. An active or uncertain operation can have `success: false` and `retry.next_action: "recover_first"`. Preserve its key while reviewing the saved state.' },
        ],
      },
      {
        id: 'key-contract',
        title: 'The key binds the request',
        blocks: [
          { kind: 'text', text: 'An exact repeat of `POST /v2/fetch` with the same key returns the existing operation, which may still be running. Concurrent identical submissions share the same durable operation.' },
          { kind: 'text', text: 'Changing the URL, method, headers, body, profile version, proxy route, country, supplied session, cost ceiling or enabled retry policy under a bound key returns HTTP `409` with `idempotency_conflict`. Omitted `retry` and `retry: false` are equivalent.' },
          { kind: 'note', title: 'After an uncertain outcome', text: 'Recover the saved operation before creating any replacement request. A new key can cause new source work. Preserve the original key and request when transport or remote state is uncertain.' },
        ],
      },
      {
        id: 'retry-guidance',
        title: 'Read the retry guidance',
        blocks: [
          { kind: 'table', headers: ['Field', 'Meaning'], rows: [
            ['`lookup_url`', 'Relative gateway URL for the saved operation.'],
            ['`same_key_replay_safe`', 'Exact replay or lookup preserves the existing operation.'],
            ['`safe_to_retry`', 'Whether the saved guidance permits a deliberate new source attempt now.'],
            ['`new_request_allowed`', 'Whether current guidance allows a new request, subject to approvals and budgets.'],
            ['`next_action`', 'The recovery, review, wait or completion action to follow.'],
          ] },
          { kind: 'table', headers: ['Outcome', 'Next step'], rows: [
            ['Active, unknown or incomplete work', 'Recover first and review retained evidence.'],
            ['Source 429 or cooldown', 'Respect source Retry-After and the saved wait guidance.'],
            ['Source 404', 'Check the intended URL.'],
            ['Known datacenter GET 403 or challenge', 'When explicitly suggested and approved, consider residential with a new key and a fresh session.'],
            ['Quota or budget rejection', 'Review the relevant allowance with your operator.'],
            ['Profile, method or route rejection', 'Correct the approved request or have the configuration reviewed.'],
          ] },
          { kind: 'text', text: 'For a deliberate approved route change, use a new operation key and omit `session_id`. Existing sessions keep their profile, provider, proxy class and country. Follow the response guidance and project approvals before dispatch.' },
        ],
      },
      {
        id: 'recover-by-operation',
        title: 'Look up an operation ID',
        blocks: [
          { kind: 'text', text: '`GET /v2/fetch/operations/:operation_id` projects a project-owned native HTTP operation into the same envelope. It also supports HTTP operations created through the native v2 operation API. Use the returned `retry.lookup_url` for further recovery.' },
          { kind: 'text', text: 'For native operations, `idempotency_key_scope` identifies the native key scope and `same_key_replay_safe` is false. The `GET` lookup remains read-only. The operation projection supports HTTP operations; browser evidence uses its separate API.' },
          { kind: 'link', label: 'Interpret gateway and source errors', href: '/docs/errors' },
        ],
      },
    ],
  },
  {
    slug: 'errors',
    title: 'Errors and status codes',
    description: 'Distinguish gateway rejection, source HTTP errors and uncertain outcomes.',
    group: 'Guides',
    sections: [
      {
        id: 'read-the-envelope',
        title: 'Read the complete envelope',
        blocks: [
          { kind: 'text', text: 'The `/v2/fetch` family returns a structured envelope. Inspect `gateway_http_status`, `state`, `success`, `data.status`, `error.code` and `retry.next_action` together. Error messages are safe summaries; diagnostics can identify the failure stage.' },
          { kind: 'code', title: 'Retained source error excerpt', snippets: [{ label: 'JSON', language: 'json', code: `{
  "success": false,
  "state": "completed",
  "gateway_http_status": 200,
  "data": { "status": 403 },
  "error": {
    "code": "source_forbidden",
    "message": "The source returned HTTP 403.",
    "stage": "source_response"
  }
}` }] },
          { kind: 'text', text: 'This excerpt omits the remaining envelope fields. Admission failures can return HTTP 400, 401, 403, 409 or 429 with `state: "rejected"`. An unclassified error after possible dispatch can report `state: "unknown"` and recovery guidance.' },
        ],
      },
      {
        id: 'gateway-errors',
        title: 'Common gateway errors',
        blocks: [
          { kind: 'table', headers: ['Code', 'Gateway status', 'Action'], rows: [
            ['`unauthorized`', '401', 'Check the Bearer token and project gateway.'],
            ['`request_invalid`', '400', 'Check JSON types, supported fields and request structure.'],
            ['`idempotency_key_required`', '400', 'Supply a valid durable operation key.'],
            ['`proxy_required`, `country_required`', '400', 'Specify the class and explicit approved country, or null for direct.'],
            ['`access_profile_forbidden`', '403', 'Choose an exact profile version approved for this project.'],
            ['`proxy_class_forbidden`, `country_forbidden`', '403', 'Select an approved route from the profile.'],
            ['`idempotency_conflict`', '409', 'Recover the original request bound to this key.'],
            ['`capability_unsupported`', '409', 'Use the native HTTP request fields supported by this endpoint.'],
            ['`session_busy_or_unknown`', '409', 'Recover the active or uncertain session operation first.'],
            ['`cost_estimate_unavailable`', '409', 'Ask for an available route estimate before using a finite ceiling.'],
            ['`client_quota_exhausted`, `residential_budget_exhausted`', '429', 'Review the project quota or bandwidth reservation.'],
            ['`cost_ceiling_exceeded`', '429', 'Review the conservative estimate and intended spending ceiling.'],
            ['`operation_not_found`', '404', 'Check the original project, key or operation ID and retention.'],
          ] },
          { kind: 'text', text: 'Other profile and admission codes can be returned. Preserve the stable code, operation ID and safe diagnostics when asking your operator to review a failure.' },
        ],
      },
      {
        id: 'source-and-transport-errors',
        title: 'Source and transport outcomes',
        blocks: [
          { kind: 'table', headers: ['Code', 'Meaning and next step'], rows: [
            ['`source_forbidden`', 'Source returned 403. Follow saved guidance and approved source access.'],
            ['`source_not_found`', 'Source returned 404. Check the URL.'],
            ['`source_rate_limited`', 'Source returned 429. Respect `data.retry_after` and the saved wait guidance.'],
            ['`source_challenge`', 'A recognized HTML challenge was retained, including challenges served as HTTP 200.'],
            ['`source_http_error`', 'A retained source status falls outside the successful range.'],
            ['`proxy_connect_rejected`', 'The proxy rejected the tunnel. Inspect safe provider status and stage.'],
            ['`source_timeout_unknown`, `source_transport_unknown`', 'Transport outcome may be uncertain. Recover before new source work.'],
            ['`source_body_incomplete`', 'The response body was incomplete. Recover and review retained evidence.'],
            ['`operation_incomplete`', 'The operation is active, uncertain or incomplete. Use its lookup URL.'],
          ] },
          { kind: 'text', text: 'A proxy tunnel rejection has a separate provider status and stage. A source status is present only when a native response is available. Measured failed traffic can still appear in usage and accounting.' },
          { kind: 'link', label: 'Recover a saved result', href: '/docs/recovery' },
        ],
      },
    ],
  },
  {
    slug: 'jobs',
    title: 'Asynchronous jobs',
    description: 'Queue approved v1 collection work, poll its saved result and cancel queued jobs.',
    group: 'Guides',
    method: 'POST',
    endpoint: '/v1/jobs',
    sections: [
      {
        id: 'availability',
        title: 'Use an enabled v1 job profile',
        blocks: [
          { kind: 'note', title: 'v1 job contract', text: 'Jobs require an enabled queue and an approved v1 profile on your provisioned gateway. They use the `/v1/fetch` request schema with a string `profile`. The v2 HTTP fetch request has its own profile, route and response contract.' },
          { kind: 'link', label: 'Read the v1 workflow fetch request contract', href: '/docs/workflow-fetch' },
          { kind: 'text', text: 'List available job profiles with `GET /v1/profiles`. Profiles expose execution mode, country, methods, reviewed recipe names and response limit. A profile with `captcha.async_required` requires the job API.' },
          { kind: 'code', title: 'Find a v1 profile', snippets: [{ label: 'cURL', language: 'bash', code: `curl --silent --show-error "$FETCHX_URL/v1/profiles" \\
  -H "Authorization: Bearer $FETCHX_TOKEN"` }] },
        ],
      },
      {
        id: 'submit-a-job',
        title: 'Submit a job',
        blocks: [
          { kind: 'text', text: 'Save a distinct job key before submission. Replace the fictional profile and destination below with approved v1 values. Use each key for one submission mode. Identical queued submissions replay the same job, while changed payloads conflict.' },
          { kind: 'code', title: 'POST /v1/jobs', snippets: [{ label: 'cURL', language: 'bash', code: `curl --silent --show-error "$FETCHX_URL/v1/jobs" \\
  -H "Authorization: Bearer $FETCHX_TOKEN" \\
  -H 'Content-Type: application/json' \\
  --data '{
    "profile": "source.http",
    "url": "https://source.example/data",
    "idempotency_key": "job-001"
  }'` }] },
          { kind: 'code', title: 'HTTP 202 response excerpt', snippets: [{ label: 'JSON', language: 'json', code: `{
  "id": "00000000-0000-4000-8000-000000000003",
  "state": "queued",
  "error": null,
  "operation": null
}` }] },
          { kind: 'text', text: 'The complete response also includes `created_at` and `expires_at`. Save the job ID. Optional fields follow the approved v1 fetch contract, including reviewed browser recipe inputs where configured.' },
        ],
      },
      {
        id: 'read-and-cancel',
        title: 'Read or cancel a job',
        blocks: [
          { kind: 'table', headers: ['Method', 'Path', 'Behavior'], rows: [
            ['`GET`', '`/v1/jobs/:id`', 'Returns state and, when retained, the nested source result.'],
            ['`DELETE`', '`/v1/jobs/:id`', 'Cancels a queued job. Running work returns `job_not_cancellable`.'],
          ] },
          { kind: 'code', title: 'Read a job', snippets: [{ label: 'cURL', language: 'bash', code: `curl --silent --show-error \\
  "$FETCHX_URL/v1/jobs/00000000-0000-4000-8000-000000000003" \\
  -H "Authorization: Bearer $FETCHX_TOKEN"` }] },
          { kind: 'text', text: 'Job states include `queued`, `running`, `completed`, `failed`, `unknown`, `cancelled` and `expired`. A completed job means processing finished. Inspect `result.status`, `result.error`, the returned body and any reviewed extraction before accepting application data.' },
        ],
      },
      {
        id: 'queue-and-recovery',
        title: 'Queue limits and recovery',
        blocks: [
          { kind: 'text', text: 'Queued jobs expire after 30 minutes if execution has not started. The default pending/running limit is 20 per project and 100 globally, with project-specific limits set by your operator. A full queue returns `job_queue_full`; a disabled queue returns `jobs_disabled`.' },
          { kind: 'text', text: 'Queued work survives restart. Interrupted running work becomes `unknown`; FetchX checks retained captures during job lookup. Preserve the original job and key while its result is uncertain. Source and bandwidth limits still apply when the worker dispatches the request.' },
          { kind: 'link', label: 'Use the synchronous v1 workflow fetch API', href: '/docs/workflow-fetch' },
        ],
      },
    ],
  },
];
