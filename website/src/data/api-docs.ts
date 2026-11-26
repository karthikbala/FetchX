// The developer docs at /docs, built from docs/openapi.json wherever a field,
// status or example exists there, so the docs cannot drift from the API.
import {
  contractOperation, contractOperations, parameterRows, requestExample, requestRows, responseExample,
  responseRows, statusRows,
} from '../lib/openapi-reference.ts';
import { codingAgentGuidePath, codingAgentGuideSlug, codingAgentPrompt } from './coding-agent.ts';

export type DocSnippet = {
  label: string;
  language: 'bash' | 'javascript' | 'python' | 'json' | 'text';
  code: string;
};

export type DocBlock =
  | { kind: 'text'; text: string }
  | { kind: 'note'; title: string; text: string }
  | { kind: 'code'; title: string; snippets: DocSnippet[]; omitFromMarkdown?: boolean }
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
  method?: 'GET' | 'POST' | 'DELETE';
  endpoint?: string;
  sections: DocSection[];
};

const createFetch = contractOperation('createFetch');
const createNextPage = contractOperation('createNextPage');
const getUsage = contractOperation('getUsage');
const getBalance = contractOperation('getBalance');
const createBatch = contractOperation('createBatch');
const batchOperations = contractOperations.filter(operation => operation.path.startsWith('/v1/batches'));
const createEstimate = contractOperation('createEstimate');
const getStatus = contractOperation('getStatus');
const getPrices = contractOperation('getPrices');
const getMe = contractOperation('getMe');
const sendFeedback = contractOperation('sendFeedback');
const getFeedback = contractOperation('getFeedback');
const scopeText = (scope: string | undefined) => scope === 'any' ? 'any valid API key' : scope ? '`' + scope + '`' : 'none';
const hostedApi = 'https://app.fetchx.ai';
const json = (value: unknown) => JSON.stringify(value, null, 2);
const openApiLink: DocBlock = { kind: 'link', label: 'OpenAPI contract (JSON)', href: '/openapi.json' };

const minimal = requestExample(createFetch, 'minimal');
const markdownRequest = requestExample(createFetch, 'markdown');
const succeeded = responseExample(createFetch, 'succeeded');
const failed = responseExample(createFetch, 'failed');
const pending = responseExample(createFetch, 'pending', '202');
const batchRequest = requestExample(createBatch, 'urls');
const batchQueued = responseExample(createBatch, 'queued', '202');

function fetchSnippets(body: Record<string, unknown>): DocSnippet[] {
  return [
    { label: 'cURL', language: 'bash', code: `curl "$FETCHX_URL/v1/fetch" \\
  -H "Authorization: Bearer $FETCHX_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body)}'` },
    { label: 'JavaScript', language: 'javascript', code: `import {FetchXClient} from './clients/javascript.mjs';

const fetchx = new FetchXClient({url: process.env.FETCHX_URL, token: process.env.FETCHX_TOKEN});
const result = await fetchx.fetch(${JSON.stringify(body)});
if (result.status === 'succeeded') console.log(result.data);
else console.log(result.error.code, result.error.next);` },
    { label: 'Python', language: 'python', code: `import os
from clients.python import FetchXClient

fetchx = FetchXClient(os.environ['FETCHX_URL'], os.environ['FETCHX_TOKEN'])
result = fetchx.fetch(**${JSON.stringify(body)})
print(result['status'], result['error'] or result['data'])` },
  ];
}

const isJson = (operation: (typeof contractOperations)[number]) =>
  Object.values(operation.responses).some(response => 'content' in response && !!response.content?.['application/json'] && 'schema' in response.content['application/json']);

function operationSection(operation: (typeof contractOperations)[number]): DocSection {
  const blocks: DocBlock[] = [{ kind: 'text', text: '`' + operation.method + ' ' + operation.path + '` · '
    + (operation.scope === 'any' ? 'any valid API key.' : operation.scope ? 'key scope `' + operation.scope + '`.' : 'no API key needed.') }];
  if (operation.description) blocks.push({ kind: 'text', text: operation.description });
  const parameters = parameterRows(operation);
  if (parameters.length) blocks.push({ kind: 'table', headers: ['Parameter', 'In', 'Type', 'Required', 'Description'], rows: parameters });
  if (operation.method !== 'DELETE' && isJson(operation) && operation.responses['200'] && 'content' in operation.responses['200']
    && operation.responses['200'].content?.['application/json']) {
    blocks.push({ kind: 'table', headers: ['Response field', 'Type', 'Description'], rows: responseRows(operation) });
  }
  blocks.push({ kind: 'table', headers: ['HTTP status', 'Meaning'], rows: statusRows(operation) });
  return { id: operation.operationId, title: operation.summary, blocks };
}

const scopeRows = ['fetch:write', 'fetch:read', 'usage:read'].map(scope => [
  '`' + scope + '`',
  contractOperations.filter(operation => operation.scope === scope).map(operation => '`' + operation.method + ' ' + operation.path + '`').join(', '),
]);

const ladderRows = [
  ['1', 'HTTP, direct', '1'],
  ['2', 'HTTP, datacenter proxy', '1'],
  ['3', 'HTTP, residential IP (a fresh IP after each 429)', '5'],
  ['4', 'Browser (Camoufox), residential IP', '25'],
  ['5', 'Browser, another residential IP', '25'],
  ['6', 'Browser, datacenter proxy', '10'],
];

const requestErrorRows = [
  ['400', '`invalid_request`', 'A field is missing or wrong. `error.details.field` names it.'],
  ['400', '`url_not_allowed`', 'The URL is not public http or https.'],
  ['401', '`unauthorized`', 'The API key is missing, wrong or revoked.'],
  ['401', '`api_key_expired`', 'The API key passed its expiry (`error.details.expired_at`). Change its expiry in the console or make a new key.'],
  ['402', '`insufficient_credits`', 'The balance is below the cheapest step this request could take. `error.details` has the balance and what is needed.'],
  ['402', '`max_credits_too_low`', '`max_credits` is below the cheapest step. Raise it to at least `error.details.min_credits`.'],
  ['402', '`payment_hold`', 'Spending is paused while a payment issue is resolved.'],
  ['402', '`key_limit_reached`', 'The API key’s own credit limit for the day or month has less left than the cheapest step. `error.details` names the limit (`credits_per_day` or `credits_per_month`) and `resets_at`. Nothing was sent or charged.'],
  ['403', '`api_key_scope_forbidden`', 'The key does not have the scope this endpoint needs.'],
  ['404', '`not_found`', 'No request with that id in this project.'],
  ['404', '`capture_not_found`', 'The request was made without `capture`, so it has no network calls to read.'],
  ['404', '`route_not_found`', 'No such route. `error.details` links the docs, the changelog and the status page.'],
  ['409', '`idempotency_conflict`', 'The `idempotency_key` was used before with a different body. Use a new key.'],
  ['409', '`no_next_page`', 'A next page was asked for a request that has none. `error.details.reason` is `failed`, `none_found`, `limit` (the list is too deep to reach again) or `url_not_allowed`.'],
  ['409', '`pending`', 'The request is still running. Wait for it to finish.'],
  ['410', '`route_retired`', 'The route was retired. `error.details.replacement` says what to use, and `retired_in` the version that removed it.'],
  ['410', '`content_expired`', 'The request\'s content expired (7 days) or was deleted, so its body or its next page can no longer be read. Fetch it again.'],
  ['413', '`request_too_large`', 'The request body is over 1 MB.'],
  ['429', '`too_many_requests`', 'The project has too many requests running. Wait `retry_after_seconds`.'],
  ['503', '`unavailable`', 'FetchX cannot take work right now. Wait for `Retry-After` (also `retry_after_seconds`) and resend with the same key.'],
  ['503', '`extract_unavailable`', 'The request asks for `extract`, and FetchX cannot read pages into JSON right now. Nothing was fetched or charged. Wait `retry_after_seconds`, or send it without `extract`.'],
  ['503', '`maintenance`', 'Planned maintenance has paused the API. Nothing was run or charged. Wait for `Retry-After` and resend with the same key; `error.details.status_url` shows progress.'],
];
const fetchErrorRows = [
  ['`blocked`', 'The site refused every route FetchX was allowed to try: a 403, a challenge page, or a captcha that could not be solved.', '`retry_later` (900 s, or the site’s own wait). With `route` set: `use_auto`.', 'Yes, after the wait. With `use_auto`: no, remove `route` first.'],
  ['`rate_limited`', 'The site returned 429, even after fresh residential IPs.', '`retry_after`, with the site’s own wait (60 s when it gives none)', 'Yes, after the wait'],
  ['`content_missing`', 'The page loaded on every route tried, but without what `expect` asked for, or without a required `extract` field. `data` shows what came back; `data.extract_report` names the fields.', '`check_expect` (300 s)', 'Yes, after the wait, if `expect` and `required` are right for this page. Otherwise fix them first.'],
  ['`login_required`', 'The site returned 401.', '`provide_credentials`: send its cookie or Authorization header', 'No: add the credentials first'],
  ['`site_error`', 'The site returned a 5xx error.', '`retry_later` (300 s)', 'Yes, after the wait'],
  ['`unreachable`', 'DNS, connection or TLS failed on every route.', '`check_url` (300 s)', 'Yes, once the URL is right, after the wait'],
  ['`url_not_allowed`', 'The site resolves, or redirects, to a private or reserved address.', '`check_url`', 'No: FetchX only fetches public sites'],
  ['`cooling_down`', 'Every route for this site is resting after recent failures, so nothing was sent.', '`retry_after` (300 s, or until the rest ends)', 'Yes, after the wait'],
  ['`route_unavailable`', 'No allowed route can be used, for example `route` names one this service does not have. When FetchX has used its own traffic allowance for that route for now, the action is `retry_later` (3600 s).', '`use_auto`, or `retry_later`', 'With `use_auto`: no, remove `route` or `country` first. With `retry_later`: yes, after the wait.'],
  ['`timeout`', '`timeout_ms` ran out.', '`raise_timeout`, or send with `async: true`', 'Yes, with a higher `timeout_ms` or `async: true`'],
  ['`too_large`', 'The response is over 10 MB, or the rendered page is over 5 MB.', '`render_never` for large files', 'No: send it with `render: never`'],
  ['`uncertain`', 'The outcome is unknown: FetchX restarted while it ran, or the connection dropped after a POST was sent.', 'GET and HEAD: `retry_later` (5 s). Other methods: `recover`.', 'GET and HEAD: yes. Other methods: no, check the site first, because it may have acted on the request.'],
  ['`next_page_missing`', 'A next page reached by clicking or scrolling could not be reached again: when FetchX opened the list, its Next control was gone. The list may have changed.', '`refetch_previous`: fetch the earlier page again, then ask for its next page', 'No: fetch the earlier page again first'],
  ['`action_failed`', 'One of the request’s `actions` failed (`error.details.action_index`; `data.actions[i].error` says why, such as `selector_not_found` or `timeout`), or the page did not answer 2xx, so none ran (`page_not_ok`). `data` holds the page as it was then. Not charged.', '`fix_actions`', 'No: fix the action first'],
];

export const docPages: DocPage[] = [
  {
    slug: '',
    title: 'Quickstart',
    description: 'Get any public URL with one call. FetchX picks the route and charges only when it gets the data.',
    group: 'Getting started',
    sections: [
      {
        id: 'set-up',
        title: 'Set up',
        blocks: [
          { kind: 'text', text: 'Sign up, create a project (your first project gets trial credits), and create an API key under API keys. The key is shown once: keep it in your server environment.' },
          { kind: 'link', label: 'Create an account', href: '/signup' },
          { kind: 'code', title: 'Environment', snippets: [{ label: 'Shell', language: 'bash', code: `export FETCHX_URL='${hostedApi}'\nexport FETCHX_TOKEN='fxk_...'` }] },
        ],
      },
      {
        id: 'fetch',
        title: 'Fetch a URL',
        blocks: [
          { kind: 'text', text: 'Only `url` is required. FetchX starts with the cheapest route, moves to a residential IP or a browser when the site blocks it, and remembers what worked for that site so the next request starts there.' },
          { kind: 'code', title: 'POST /v1/fetch', snippets: fetchSnippets(minimal) },
          { kind: 'text', text: '`formats` picks what comes back: the raw `body` (the default when you leave `formats` out), markdown, plain text, links, page metadata, a screenshot, or for a JSON API its `skeleton`: every field with its type, array sizes and a one-element sample, a few KB however large the body. The body is only returned when you list it, so ask for what you will use. For structured data from a page, use `extract`.' },
          { kind: 'code', title: 'Markdown from a page that needs a browser', snippets: fetchSnippets(markdownRequest) },
        ],
      },
      {
        id: 'result',
        title: 'Read the result',
        blocks: [
          { kind: 'text', text: 'A fetch that ran answers HTTP 200 with `status: succeeded` or `status: failed`. `data` holds what the site answered, `attempts` lists every route tried, and `credits.charged` is what it cost: 0 unless it succeeded. `credits.balance` is what the project has left, and `credits.breakdown` shows how the charge was made up.' },
          { kind: 'text', text: '`page_status` says what the page was: `content`, `not_found` (the site’s real 404), `empty`, `challenge` or `error`. `challenge` names any bot wall FetchX met on the way, such as `cloudflare` or `datadome`, and whether it got past it by rotating IPs, solving a captcha or waiting.' },
          { kind: 'code', title: 'Succeeded', snippets: [{ label: 'JSON', language: 'json', code: json(succeeded) }] },
          { kind: 'text', text: 'A failed fetch says what happened and what to do next, in `error.next`. It is never charged.' },
          { kind: 'code', title: 'Failed', snippets: [{ label: 'JSON', language: 'json', code: json(failed) }] },
          { kind: 'link', label: 'All request options', href: '/docs/fetch' },
          { kind: 'link', label: 'Errors and next steps', href: '/docs/errors' },
        ],
      },
      {
        id: 'retries',
        title: 'Retry safely',
        blocks: [
          { kind: 'text', text: 'Send an `idempotency_key` with each request (the SDKs add one for you). If a response is lost, or the call gets 429 or 503, send the same body with the same key: FetchX returns the first result and charges once. The same key with a different body is refused with 409.' },
          { kind: 'text', text: 'A key keeps its first result for 90 days, failures included, and never runs the fetch again. To try a failed fetch again, read `error.next`: when `retry_with_new_key` is true, wait `retry_after_seconds` (when given) and send it with a new key. When it is false, the same request would fail the same way, so change it as `next.action` says first.' },
          { kind: 'link', label: 'Every error and when to retry', href: '/docs/errors' },
        ],
      },
    ],
  },
  {
    slug: codingAgentGuideSlug,
    title: 'FetchX for coding agents',
    description: 'Give a coding agent a FetchX key with Connect, make one fetch and check the result.',
    group: 'Getting started',
    sections: [
      {
        id: 'copy-prompt',
        title: 'Copy the prompt into your coding agent',
        blocks: [
          { kind: 'text', text: 'Paste this into your agent and tell it the URL and what you want back. If your agent already downloaded this guide, start at step 1.' },
          { kind: 'code', title: 'FetchX onboarding prompt', snippets: [{ label: 'Plain text', language: 'text', code: codingAgentPrompt }], omitFromMarkdown: true },
        ],
      },
      {
        id: 'get-a-key',
        title: '1. Get a key',
        blocks: [
          { kind: 'text', text: 'If `FETCHX_URL` and `FETCHX_TOKEN` are already set, go to step 2. Otherwise run the Connect helper (Node.js 24) around the agent command. It shows a link and a short code; the user opens the link, signs in or signs up, checks that the page shows the same code, picks a project or creates one, and approves within 20 minutes. The helper then starts the command with `FETCHX_URL` and `FETCHX_TOKEN` set. The key can send and read requests and read usage, up to the credit limits asked for (`--credits-per-day`, `--credits-per-month`, `--expires-in-days`) and approved by the user.' },
          { kind: 'code', title: 'Download the helper and connect', snippets: [{ label: 'Shell', language: 'bash', code: `curl --fail --silent --show-error --proto '=https' --output connect-client.mjs https://fetchx.ai/connect-client.mjs
node ./connect-client.mjs --credits-per-day 500 -- codex` }] },
          { kind: 'text', text: 'Without Connect, the user creates a key under API keys and stores it as the secret `FETCHX_TOKEN`, with `FETCHX_URL` set to `' + hostedApi + '`.' },
          { kind: 'note', title: 'Keep the key private', text: 'Share only the Connect link and its short code. Keep the key out of chat, command arguments, files and logs, and send it only to `FETCHX_URL`.' },
        ],
      },
      {
        id: 'fetch',
        title: '2. Fetch once',
        blocks: [
          { kind: 'text', text: 'A fetch can use credits, so confirm the URL with the user first. Send it once with an `idempotency_key` you keep.' },
          { kind: 'code', title: 'POST /v1/fetch', snippets: [{ label: 'Node.js', language: 'javascript', code: `const key = crypto.randomUUID();
const response = await fetch(process.env.FETCHX_URL + '/v1/fetch', {
  method: 'POST',
  headers: {Authorization: 'Bearer ' + process.env.FETCHX_TOKEN, 'Content-Type': 'application/json'},
  body: JSON.stringify({url: 'https://shop.example.com/p/42', formats: ['markdown'], idempotency_key: key}),
  signal: AbortSignal.timeout(90_000),
});
const result = await response.json();
console.log(response.status, result.status, result.error?.next ?? result.data?.markdown?.slice(0, 500));` }] },
        ],
      },
      {
        id: 'check',
        title: '3. Check the result and report',
        blocks: [
          { kind: 'text', text: '`status: succeeded` means the site gave its real answer; check `data.markdown` or `data.body` against what the user asked for. Pass `expect` (a selector or text the page must show) and FetchX checks it for you and never charges for a page without it. `status: failed` comes with `error.next.action`: follow it rather than guessing, and retry with a new key only when `error.next.retry_with_new_key` is true. A lost response is resent with the same key and body, which returns the first result and is never charged twice. Report the outcome before doing more work.' },
          { kind: 'link', label: 'Errors and next steps', href: '/docs/errors' },
        ],
      },
    ],
  },
  {
    slug: 'authentication',
    title: 'Authentication and keys',
    description: 'Project API keys, their scopes, rotation, and the Connect flow for agents.',
    group: 'Getting started',
    sections: [
      {
        id: 'bearer',
        title: 'Send your key',
        blocks: [
          { kind: 'text', text: 'Every API call sends `Authorization: Bearer fxk_...`. A key belongs to one project; requests, results and credits are scoped to it. A missing or revoked key returns 401; a key without the endpoint’s scope returns 403.' },
          { kind: 'table', headers: ['Scope', 'Endpoints'], rows: scopeRows },
          { kind: 'text', text: '`GET /v1/me` works with any valid key, whatever its scopes. It says which project and key are calling and what the key may do, so a tool can check a key before it starts. `project_id` stays the same when a key is rotated or replaced; use it to recognise the customer.' },
        ],
      },
      operationSection(getMe),
      {
        id: 'lifecycle',
        title: 'Create, rotate and revoke',
        blocks: [
          { kind: 'text', text: 'Keys are created in the console under API keys and shown once; FetchX keeps only a hash. Rotating creates a new key and revokes the old one at once. Revoking stops a key immediately. Results stay with the project and can be read with any other key that has `fetch:read`.' },
          { kind: 'text', text: 'Keep keys on your server. Never put one in browser code, a public repository, or a header sent to the site you fetch: FetchX refuses requests that contain its own keys.' },
        ],
      },
      {
        id: 'key-limits',
        title: 'Limit what a key can spend',
        blocks: [
          { kind: 'text', text: 'A key can have its own credit limit per day and per month, and an expiry, so you can hand it to a tool, a scheduler or a teammate without handing over the whole balance. Set them when you create the key, or later with Limits next to it. Days and months are UTC. A key’s spend is what its requests were charged plus what its running requests hold, counted by when each request started; rotating a key keeps its limits and what it has spent.' },
          { kind: 'text', text: 'A request reserves no more than the key’s limit has left. When that is less than the cheapest step the request could take, it is refused before anything is sent: 402 `key_limit_reached`, with `error.details.limit` (`credits_per_day` or `credits_per_month`), `credits`, `used`, `remaining`, `needed` and `resets_at`. A batch whose key reaches its limit pauses with `paused_reason: key_limit_reached` and starts again by itself when the limit resets. After its expiry a key answers 401 `api_key_expired` with `error.details.expired_at`.' },
          { kind: 'text', text: '`GET /v1/me` shows the key’s `limits`: for each of `credits_per_day` and `credits_per_month` the `limit`, `used`, `remaining` and `resets_at` (or `null` for no limit), and `expires_at`.' },
        ],
      },
      {
        id: 'connect',
        title: 'Connect for agents and CLIs',
        blocks: [
          { kind: 'text', text: 'Connect gives a tool a key after the user approves it in the browser, without copying secrets. The tool never receives the key: it works it out from a private device code once the user approves. The JavaScript helper (`connect-client.mjs`) does all of this; see the coding agent guide. Any language can do it in three steps.' },
          { kind: 'table', headers: ['Step', 'What to do'], rows: [
            ['1. Start', '`POST https://fetchx.ai/api/control/connect/start` with `{"client_name": "My tool"}` and, for a capped key, `limits`: `credits_per_day`, `credits_per_month`, and `expires_at` or `expires_in_days`. Send no Origin, Cookie or Authorization header. The answer has `request_id`, `device_code` (keep it private), `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in` (seconds, 1,200 today), `interval` (seconds) and the `limits` asked for.'],
            ['2. Show the link', 'Show the user `verification_uri_complete`. It carries the code, so the approval page shows it and the user checks that it matches the `user_code` your tool shows. The user signs in or signs up, picks a project or creates one there, may change or remove the limits, and approves.'],
            ['3. Claim', 'Every `interval` seconds, `POST https://fetchx.ai/api/control/connect/claim` with `{"request_id", "device_code"}`. `state` is `pending`, `denied`, `expired` or `connected`; on 429 `connect_slow_down`, wait 5 seconds longer each time. `connected` brings `project_id`, `key_id`, `api_base_url` and the key\'s `limits`. The key is `fxk_` followed by the unpadded base64url SHA-256 of `fetchx-connect-key-v1`, a zero byte, and the device code.'],
          ] },
          { kind: 'text', text: 'The key has the scopes `fetch:read`, `fetch:write` and `usage:read`, and its name is the `client_name`. The user can change its limits or revoke it in the console; a revoked key answers 401 `unauthorized`, an expired one 401 `api_key_expired`. Store it like a password: in an owner-only file or a secret store, never in a project folder, a command line or a log.' },
          { kind: 'link', label: 'FetchX for coding agents', href: codingAgentGuidePath },
        ],
      },
    ],
  },
  {
    slug: 'fetch',
    title: 'POST /v1/fetch',
    description: 'Every request option, how auto mode picks a route, and the response.',
    group: 'API reference',
    method: createFetch.method,
    endpoint: createFetch.path,
    sections: [
      {
        id: 'options',
        title: 'Request options',
        blocks: [
          { kind: 'text', text: createFetch.description ?? '' },
          { kind: 'table', headers: ['Field', 'Type', 'Required', 'Description'], rows: requestRows(createFetch) },
        ],
      },
      {
        id: 'auto-mode',
        title: 'How auto mode picks a route',
        blocks: [
          { kind: 'text', text: 'Without `route`, FetchX climbs this ladder one step at a time until the site gives its real answer. It starts at the step that worked for this site in the last few days, skips steps that are resting after failures, and never goes past `max_attempts`, `max_credits` or `timeout_ms`. Only the step that got the data is charged, at the price shown.' },
          { kind: 'table', headers: ['Step', 'Route', 'Credits'], rows: ladderRows },
          { kind: 'text', text: 'A page whose content is drawn by JavaScript (next to no text, a page that says it needs JavaScript, or content that arrives as script data) moves straight to a browser. A 429 moves to a fresh residential IP. In a browser, Turnstile, reCAPTCHA, hCaptcha and MTCaptcha challenges (and DataDome, where enabled) are solved when they stand in the way, for 10 credits more. A captcha on a form that still needs your details (a sign-in) is not solved, since a token alone cannot get past it. `render: always` (or `wait_for`, or a screenshot) starts at step 4; `render: never` stops at step 3.' },
          { kind: 'text', text: 'Only GET and HEAD climb. Any other method gets one attempt on the first allowed route and is never resent, because it may change data on the site.' },
          { kind: 'text', text: '`fix_headers` (on by default) replaces automation User-Agents such as curl or python-requests with a browser one and adds a missing Accept and Accept-Language. Your own cookies and Authorization header are sent as given.' },
        ],
      },
      {
        id: 'expect',
        title: 'Make sure the page has what you need',
        blocks: [
          { kind: 'text', text: 'Some sites answer 200 with a page that is not the one you asked for: a frame with no prices, a skeleton, or an empty template served to suspected bots. Pass `expect` with a CSS `selector` that must match, `text` that must appear, or a `min_markdown_length`. A page without it is not a success: FetchX tries a browser and fresh residential IPs, and if no route shows it the request fails with `content_missing` and is not charged.' },
          { kind: 'text', text: 'In a browser, `expect.selector` is also what FetchX waits for (up to 10 seconds) unless you set `wait_for`.' },
          { kind: 'text', text: 'A next page (`POST /v1/fetch/{id}/next`) keeps the earlier request’s `expect`. Pass `expect` there to replace it, or `null` to drop it when later pages of a list show something else.' },
        ],
      },
      {
        id: 'extract',
        title: 'Get JSON in your own shape',
        blocks: [
          { kind: 'text', text: 'Pass `extract` with a small JSON Schema and FetchX reads the page into it. Give each field a `description` of what it is; that is what the models read. A root `object` asks for one record (a product, an article, a hotel). A root `array` of objects, with a `description` of one record such as "each hotel in the results", asks for every record of that kind on a list page.' },
          { kind: 'code', title: 'One record', snippets: [{ label: 'JSON', language: 'json', code: json({ url: 'https://shop.example.com/p/42', extract: { schema: { type: 'object', required: ['price'], properties: { name: { type: 'string', description: 'Product name' }, price: { type: 'number', description: 'Price in the page currency' }, in_stock: { type: 'boolean', description: 'Can be ordered now' } } } } }) }] },
          { kind: 'text', text: 'Fields can be strings (with `format` date, date-time or uri), numbers, integers, booleans, an `enum` of strings, or arrays of strings or numbers, up to 30 per record. `instructions` adds context for every field, such as which of several prices to take.' },
          { kind: 'text', text: 'Every value is checked against the page: one the page does not show comes back `null`, never guessed, and `data.extract_report` says why (`not_found`, `unsure` or `ungrounded`). A field you list in `required` works like `expect`: if the page does not show it, FetchX tries a browser and fresh IPs, and if no route shows it the request fails with `content_missing` and is not charged.' },
          { kind: 'text', text: 'Extraction costs 10 credits per started 25,000 tokens (about 100,000 characters) of page text read, up to 150,000 tokens, on top of the step; most pages are one unit. `credits.breakdown` shows `extract_tokens` and `extract_credits`. Only the page text is sent to the models, never your headers or cookies. If extraction is unavailable, the request is refused with 503 `extract_unavailable` before anything is fetched.' },
        ],
      },
      {
        id: 'traffic',
        title: 'What a browser downloads',
        blocks: [
          { kind: 'text', text: 'Most of a heavy page’s cost is residential traffic, and a good part of that is images, video and fonts. `block_resources` (on unless you ask for a screenshot) skips the page’s own images, media and fonts, which took a large search page from 14.4 MB to 11.4 MB. Scripts, styles and data still load, so the text and markdown are the same. Frames such as a captcha keep everything they need. Set it to `false` if you need the page exactly as a person sees it.' },
        ],
      },
      {
        id: 'scroll',
        title: 'Scrolling and next pages',
        blocks: [
          { kind: 'text', text: 'In a browser, FetchX waits for a page to fill itself in, then scrolls it like a reader while scrolling loads more, up to 10 screens. `scroll: off` reads it without scrolling; a number from 1 to 50 scrolls that many screens (raise `timeout_ms` for many). Scrolling has no fee of its own, but a scrolled page loads more, and residential traffic beyond the included 5 MB is charged per MB, so `off` is the cheapest choice when the first screen is enough.' },
          { kind: 'text', text: 'A successful result says how the page leads on in `data.next_page`: a `link` to the next page, a Next or Load more button to `click`, or more to `scroll`; `null` when there is none. `data.page` says which page this is and how far it was scrolled.' },
          { kind: 'text', text: 'A page read deeper than 10 screens, and every next page, may load more traffic, so it holds enough credits for it while it runs (up to 150 MB) and is charged only for what it used, and only when it succeeds. Set `max_credits` to hold and spend less.' },
        ],
      },
      operationSection(createNextPage),
      {
        id: 'capture',
        title: 'Read the page’s own API calls',
        blocks: [
          { kind: 'text', text: 'Many pages fill themselves in from a JSON API. Pass `capture: true` and the browser records the calls the page makes while it loads and scrolls: its documents, XHR and fetch requests, with their headers and response bodies. The result’s `network` says how many calls were kept and how many were dropped, and why. Read them with `GET /v1/fetch/{id}/network`, and use `contains` with a value the page shows (a name, a price) to find the call that carries the data. `GET /v1/fetch/{id}/network/{index}` returns one call in full, and `GET /v1/fetch/{id}/network.har` all of them as a HAR file for browser developer tools.' },
          { kind: 'code', title: 'Find the call behind the page', snippets: [{ label: 'cURL', language: 'bash', code: `curl "$FETCHX_URL/v1/fetch" -H "Authorization: Bearer $FETCHX_TOKEN" -H "Content-Type: application/json" \\
  -d '{"url": "https://shop.example.com/search?q=lamp", "capture": true}'
curl -G "$FETCHX_URL/v1/fetch/$ID/network" -H "Authorization: Bearer $FETCHX_TOKEN" \\
  --data-urlencode contains=Lamp --data-urlencode content_type=json` }] },
          { kind: 'text', text: 'Capture adds nothing to the price, but it needs a browser: with `render: auto` it makes the request render, and it is refused with `render: never` or a method other than GET. Pass an object instead of `true` to choose `types` (document, xhr and fetch by default), `max_requests` (200), `max_body_bytes` (2 MB per body), `bodies` (`text`, `none` or `all`) and `first_party_only`. Calls to analytics, advertising, tag manager and consent hosts are dropped unless `include_trackers` is set. Cookies, Authorization and other secret headers are masked as `<masked len=N sha=XXXXXX>`, so two calls can be seen to carry the same value without showing it, unless `unmask` is set.' },
          { kind: 'text', text: 'Each call says on which page and when it was made: `phase` is `warmup` (a visit to the site’s home page first), `load`, `scroll`, `replay` (getting back to the earlier page for a next page) or `actions` (while your actions ran, with `action_index`, the action that set the call off). A next page keeps the earlier request’s `capture` unless you send `capture: null`. The calls are stored encrypted with the rest of the content: 7 days, or until you DELETE the request.' },
        ],
      },
      {
        id: 'actions',
        title: 'Click, type and run scripts on the page',
        blocks: [
          { kind: 'text', text: 'Pass `actions` and a browser carries them out in order once the page has loaded, in one tab: `wait` (a time, or a selector to appear or go), `wait_for_url`, `click`, `hover`, `fill`, `type`, `press`, `select`, `scroll`, `navigate`, `evaluate` and `wait_for_response`. Selectors are CSS and reach into open shadow roots. `frame` acts inside an iframe. `data.actions` has one result per action, and `data.body` is the page as the last action left it.' },
          { kind: 'code', title: 'Search a form and read the results', snippets: [{ label: 'JSON', language: 'json', code: json({ url: 'https://portal.example.com/search', allow_hosts: ['portal.example.com'], actions: [{ type: 'fill', selector: '#ids', value: 'V1,X2' }, { type: 'click', selector: 'button[type=submit]' }, { type: 'wait_for_response', url_contains: '/api/lookup', status_in: [200] }, { type: 'evaluate', mode: 'function', script: 'return document.querySelectorAll("#result tr").length' }] }) }] },
          { kind: 'text', text: '`evaluate` runs your script in the page’s own JavaScript, so it sees the page’s variables, and what one script leaves on `window` is there for the next. By default its completion value comes back, as in a console; with `mode: function` it runs as a function body with `args` and gives what it returns. Promises are awaited, and the value comes back as JSON in `data.actions[i].value`.' },
          { kind: 'text', text: '`wait_for_response` waits for the first response to a request that started after the previous action and completes, matched by `url_contains` or `url_regex`, `method` and `status_in`. It returns the exact URL, the real status, the headers and up to 2 MB of body, as the browser’s network layer saw them, in `data.actions[i].response`.' },
          { kind: 'text', text: 'Every action waits up to `timeout_ms` (15 seconds unless `action_timeout_ms` says otherwise). An action that fails stops the rest, unless it is `optional`, and the request fails with `action_failed`, free. With actions the request may take up to 5 minutes (`timeout_ms` up to 300000). It runs on a browser step only, once on a given `route`, and is never resent on another route after an action has sent something to the site. It is billed as one browser step, with nothing per action.' },
        ],
      },
      {
        id: 'allow-hosts',
        title: 'Keep a request to your hosts',
        blocks: [
          { kind: 'text', text: '`allow_hosts` lists the only hosts a request may reach: exact names, or `*.example.com` for every subdomain. In a browser, every request and connection the page makes to another host is refused before it leaves FetchX and listed in `data.blocked_requests`; over HTTP, a redirect to another host is not followed and comes back as the answer, with `data.location`. `allow_passive_subresources: true` lets the page load scripts, styles, fonts and images from other hosts, without cookies, and lists them in `data.passive_offlist_hosts`. Captcha widgets load from their vendors’ hosts, so a page with one may need those on the list.' },
        ],
      },
      {
        id: 'response',
        title: 'The response',
        blocks: [
          { kind: 'text', text: 'HTTP 200 when the fetch finished (`succeeded` or `failed`), HTTP 202 when it is still running: after 60 seconds, or at once with `async: true`. Poll `GET /v1/fetch/{id}` or pass `webhook_url`.' },
          { kind: 'table', headers: ['Field', 'Type', 'Description'], rows: responseRows(createFetch, ['data', 'credits', 'error']) },
          { kind: 'code', title: 'Pending', snippets: [{ label: 'JSON', language: 'json', code: json(pending) }] },
          { kind: 'table', headers: ['HTTP status', 'Meaning'], rows: statusRows(createFetch) },
          openApiLink,
        ],
      },
    ],
  },
  {
    slug: 'batches',
    title: 'Batches',
    description: 'Many URLs in one job, run at the pace each site can take, with results by webhook or page by page.',
    group: 'API reference',
    method: createBatch.method,
    endpoint: createBatch.path,
    sections: [
      {
        id: 'how-it-runs',
        title: 'How a batch runs',
        blocks: [
          { kind: 'text', text: 'Send up to 1000 URLs, or `POST /v1/fetch` bodies, in one call. FetchX checks every item first: one bad item refuses the whole batch with 400 and names it (`items[3].formats`, or `defaults.formats` when the default is at fault), and nothing is queued.' },
          { kind: 'text', text: 'FetchX then starts the items itself, at the pace it has learned each site can take. A site that has never refused FetchX gets up to 4 requests at once; a site that has refused or rate-limited it gets 2 at once, 4 seconds apart; a site that rate-limited it in the last 10 minutes gets 1 at a time, 15 seconds apart. Different sites run side by side, and batches waiting on the same site take turns.' },
          { kind: 'text', text: 'Each item is a request of its own, with its own id, run in auto mode like any other: up to `max_attempts` steps, and a fresh residential IP when a site walls one off. It is charged only if it succeeds, at the price of the step that got it. Failed items are free.' },
          { kind: 'text', text: 'While an item runs it holds credits for the most it could cost, like a single request. Items wait for credits your running requests hold, and a batch always leaves one of your project’s requests-at-once for single requests. When the balance cannot cover the next item, the batch pauses (`status: paused`, with `paused_reason`) and starts again by itself once you add credits. When its items ask for `extract` and FetchX cannot read pages into JSON for a while, it pauses with `paused_reason: extract_unavailable` and tries again by itself every 5 minutes, without charging anything. When the key that submitted it has a credit limit and reaches it, it pauses with `paused_reason: key_limit_reached` until the limit resets.' },
          { kind: 'text', text: 'Canceling stops the items that have not started. Items already running finish, and are charged if they succeed.' },
        ],
      },
      {
        id: 'submit',
        title: 'Submit a batch',
        blocks: [
          { kind: 'table', headers: ['Field', 'Type', 'Required', 'Description'], rows: requestRows(createBatch) },
          { kind: 'code', title: 'POST /v1/batches', snippets: [
            { label: 'cURL', language: 'bash', code: `curl "$FETCHX_URL/v1/batches" \\
  -H "Authorization: Bearer $FETCHX_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(batchRequest)}'` },
            { label: 'JavaScript', language: 'javascript', code: `import {FetchXClient} from './clients/javascript.mjs';

const fetchx = new FetchXClient({url: process.env.FETCHX_URL, token: process.env.FETCHX_TOKEN});
const batch = await fetchx.submitBatch(${JSON.stringify(batchRequest)});
for await (const item of fetchx.batchResults(batch.id)) {
  console.log(item.index, item.status, item.result?.data?.markdown?.slice(0, 200));
}` },
            { label: 'Python', language: 'python', code: `import os
from clients.python import FetchXClient

fetchx = FetchXClient(os.environ['FETCHX_URL'], os.environ['FETCHX_TOKEN'])
batch = fetchx.submit_batch(${JSON.stringify(batchRequest.items)}, defaults=${JSON.stringify(batchRequest.defaults)})
for item in fetchx.batch_results(batch['id']):
    print(item['index'], item['status'])` },
          ] },
          { kind: 'code', title: 'Queued', snippets: [{ label: 'JSON', language: 'json', code: json(batchQueued) }] },
        ],
      },
      {
        id: 'results',
        title: 'Get the results',
        blocks: [
          { kind: 'text', text: 'With `webhook_url`, FetchX POSTs each item’s result as it finishes (the result without its body, with `batch: {id, index}`, and the header `X-FetchX-Event: fetch.finished`), then the batch itself when it ends (`batch.finished`) or pauses (`batch.paused`). Deliveries are signed like every webhook.' },
          { kind: 'text', text: 'Without a webhook, read `GET /v1/batches/{id}/items?order=finished` and keep `next_cursor`: each read returns only what finished since the last one, and `next_cursor` is null once the batch is over and everything was read. The default order is the order you sent the items in. An item’s body is at `GET /v1/fetch/{request_id}/content`, kept 7 days like any result.' },
          { kind: 'link', label: 'Webhooks', href: '/docs/webhooks' },
        ],
      },
      ...batchOperations.map(operationSection),
    ],
  },
  {
    slug: 'results',
    title: 'Results, files and history',
    description: 'Read a result, download its body or screenshot, list requests and delete stored content.',
    group: 'API reference',
    sections: [
      ...contractOperations.filter(operation => ![createFetch, createNextPage, getUsage, getBalance, createEstimate, getStatus, getMe, sendFeedback, getFeedback, ...batchOperations]
        .includes(operation)).map(operationSection),
      {
        id: 'retention',
        title: 'Retention',
        blocks: [{ kind: 'text', text: 'Everything the site sent (body, headers, cookies, formats, screenshot, and the network calls of a request made with `capture`) is stored encrypted for 7 days, or until you DELETE it. The summary, attempts and credits stay for 90 days. Reading never contacts the site and is never charged.' }],
      },
    ],
  },
  {
    slug: 'errors',
    title: 'Errors and next steps',
    description: 'Refused calls (4xx) and failed fetches, each with a stable code and what to do next.',
    group: 'Guides',
    sections: [
      {
        id: 'request-errors',
        title: 'Refused calls (4xx)',
        blocks: [
          { kind: 'text', text: 'The call itself was wrong, so nothing was sent to the site and nothing was charged. The body is `{error: {code, message, details?}, request_id}`.' },
          { kind: 'text', text: 'Every answer has an `X-Request-Id` header, and every JSON answer from `/v1`, success or error, has the same id as `request_id`. It names that one call; a fetch keeps its own `id`. Log both, and quote `request_id` when you ask about a call: FetchX can find the call, and the fetch it started, from it.' },
          { kind: 'text', text: 'A refused call stores nothing under its `idempotency_key`, so once you have fixed it you can send it with the same key. The exception is 409: that key already belongs to a different request, so use a new one. After a 429 or a 503, resend the same body with the same key.' },
          { kind: 'table', headers: ['HTTP', 'Code', 'Meaning'], rows: requestErrorRows },
        ],
      },
      {
        id: 'fetch-errors',
        title: 'Failed fetches (HTTP 200, status: failed)',
        blocks: [
          { kind: 'text', text: 'The site was tried and did not give its answer. Nothing is charged. `error.next.action` is meant for programs: act on it rather than on the message. `data` holds what the site last answered, such as the block page.' },
          { kind: 'text', text: 'The key you sent now holds this failure: sending the same key again returns it without running anything. `error.next.retry_with_new_key` says whether a retry can help. When it is true, wait `error.next.retry_after_seconds` (when given) and send the request with a new key. When it is false, the same request would fail the same way, so change it first.' },
          { kind: 'table', headers: ['Code', 'What happened', 'next.action', 'Retry with a new key?'], rows: fetchErrorRows },
          { kind: 'text', text: 'With `route` set there is exactly one attempt, so the error is precise about that route and suggests auto mode.' },
        ],
      },
      {
        id: 'feedback',
        title: 'Tell us when FetchX gets a page wrong',
        blocks: [
          { kind: 'text', text: 'When a page fails through FetchX but loads from your own connection, or comes back with the wrong content or wrong extracted fields, send `POST /v1/feedback` with the request\'s `fetch_id` (or the `url`), what you saw as `kind`, and evidence from where it worked if you have it: the status code, a short part of the body, and how you fetched it. FetchX keeps a copy of what it tried for that request, and the team uses the reports to tune routes. `GET /v1/feedback/{id}` shows when it was looked at and the reply.' },
          { kind: 'text', text: 'Reports are free, up to 100 a day per project, and kept 90 days. Sending the same report again while it is open returns the first one. Leave secrets and personal data out of `message` and `evidence`: FetchX staff read them.' },
        ],
      },
      operationSection(sendFeedback),
      operationSection(getFeedback),
    ],
  },
  {
    slug: 'billing',
    title: 'Credits and usage',
    description: 'One balance, charged only when a request succeeds, at the price of the step that worked.',
    group: 'Guides',
    method: getUsage.method,
    endpoint: getUsage.path,
    sections: [
      {
        id: 'charging',
        title: 'How charging works',
        blocks: [
          { kind: 'text', text: 'When a request is admitted, FetchX reserves up to `max_credits` or the price of the most expensive step it might use. If the balance cannot cover the cheapest step, the request is refused with 402 before anything is sent. On success it charges the price of the step that got the data, plus 10 for a solved captcha, plus 5 per MB of residential transfer beyond the first 1 MB (HTTP) or 5 MB (browser), plus 10 per started 25,000 tokens of page text read for `extract`, and releases the rest. Failed requests, uncertain ones, pages without what `expect` asked for and every earlier failed step cost nothing.' },
          { kind: 'text', text: 'Every answer carries `credits`: `charged`, `max` (what was reserved), `balance` (what the project has left) and, on success, a `breakdown` of the step price, captcha credits, traffic in MB, the MB included and the traffic credits. A browser page that costs far more than its step is paying for traffic: `block_resources` (on by default) cuts the images, video and fonts out of it.' },
          { kind: 'text', text: 'Scrolling within a page has no fee, but what it loads counts as transfer. Each next page (`POST /v1/fetch/{id}/next`) and each item of a batch is a request of its own, charged the same way: only when it succeeds, at the price of the step that got it.' },
          { kind: 'text', text: 'Trial credits and purchased credits share one balance. Purchased credits do not expire.' },
        ],
      },
      {
        id: 'estimates',
        title: 'Estimates before you send',
        blocks: [
          { kind: 'text', text: '`POST /v1/estimate` takes the body you would send to `POST /v1/fetch`, or a batch of up to 1,000 (`{items, defaults}`), and says what it would cost and how long it would take. Nothing is sent to the site, reserved or charged.' },
          { kind: 'text', text: 'Figures come from what recent requests to the same site took, learned by host name only, priced with the table above, your `max_credits` and your balance. `credits.typical` is what one success usually costs, `credits.high` a high-end cost, and `credits.expected` counts only the share that usually succeeds, since failures are free. `notes` say what to change when a request would be refused (`max_credits_too_low`, `insufficient_credits`) or is likely to fail (`likely_needs_more_credits`, `cooling_down`, `low_success_rate`).' },
          { kind: 'code', title: 'Estimate a batch', snippets: [{ label: 'cURL', language: 'bash', code: `curl "$FETCHX_URL/v1/estimate" \\
  -H "Authorization: Bearer $FETCHX_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(requestExample(createEstimate, 'batch'))}'` }, { label: 'Answer', language: 'json', code: json(responseExample(createEstimate, 'batch')) }] },
        ],
      },
      {
        id: 'prices',
        title: 'Prices without a key',
        blocks: [
          { kind: 'text', text: '`GET /v1/prices` needs no API key and any origin may call it, so a tool can quote what a site will cost before the user has an account. It returns the credits each step costs, what a solved captcha, residential traffic and extraction add, and `trial_credits`, what a new account gets once. Read it rather than keeping your own copy of the table.' },
          { kind: 'code', title: 'Read the price table', snippets: [{ label: 'cURL', language: 'bash', code: `curl ${hostedApi}/v1/prices` }, { label: 'Answer', language: 'json', code: json(responseExample(getPrices, 'default')) }] },
        ],
      },
      operationSection(createEstimate),
      operationSection(getPrices),
      operationSection(getBalance),
      operationSection(getUsage),
    ],
  },
  {
    slug: 'status',
    title: 'Status, maintenance and changes',
    description: 'Whether the API is up, what it answers during maintenance, and how changes and retirements are announced.',
    group: 'Guides',
    method: getStatus.method,
    endpoint: getStatus.path,
    sections: [
      {
        id: 'maintenance',
        title: 'Maintenance',
        blocks: [
          { kind: 'text', text: 'Planned maintenance is announced on the status page at https://fetchx.ai/status before it starts. While maintenance pauses the API, every `/v1` route except `GET /v1/status` answers `503` with `error.code` `maintenance`, a `Retry-After` header and `error.details.status_url`. Nothing was run or charged: wait and resend the same body with the same `idempotency_key`. The JavaScript and Python clients do this for `fetch` and `nextPage` up to `retries` times.' },
          { kind: 'text', text: 'The status page is fed by a monitor that runs on Cloudflare, outside FetchX’s servers, so it keeps working, with 90 days of history, when the API does not answer.' },
          { kind: 'link', label: 'Status page', href: '/status' },
        ],
      },
      operationSection(getStatus),
      {
        id: 'changes',
        title: 'Changes, deprecations and retired routes',
        blocks: [
          { kind: 'text', text: 'Every change to the API is in the changelog, newest first. A breaking change is announced there as a deprecation at least 30 days before its sunset. Until the sunset the route still answers, with a `Deprecation` header (RFC 9745), a `Sunset` header (RFC 8594) and `Link: <https://fetchx.ai/changelog>; rel="deprecation"`. Log those headers in your client to hear about a change before it lands.' },
          { kind: 'text', text: 'The same goes for the fields of an answer. FetchX does not remove or rename a documented field, change its type, let it be null or missing where it always had a value, stop sending a value it lists, or change what a value means, without a deprecation in the changelog at least 30 days before. Additions ship without notice and are listed when they ship: new fields, new values, new error codes. Ignore fields you do not know, treat a value you do not know as other, and follow the Atom feed to hear about a deprecation the day it is announced.' },
          { kind: 'text', text: 'After the sunset the route answers `410 Gone` with `error.code` `route_retired` and `error.details.replacement`. An unknown route answers `404` with `error.code` `route_not_found` and links to these docs, the changelog and the status page.' },
          { kind: 'link', label: 'API changelog', href: '/changelog' },
          { kind: 'link', label: 'Changelog as an Atom feed', href: '/changelog.xml' },
        ],
      },
    ],
  },
  {
    slug: 'webhooks',
    title: 'Webhooks',
    description: 'Get the result POSTed to your server when a request finishes.',
    group: 'Guides',
    sections: [
      {
        id: 'deliveries',
        title: 'Deliveries',
        blocks: [
          { kind: 'text', text: 'Pass `webhook_url` (public https) with a request. When it finishes, FetchX POSTs the result object, without the body, to that URL, up to 3 times until it gets a 2xx. Read the body with `GET /v1/fetch/{id}` if you need it.' },
          { kind: 'text', text: 'A batch’s `webhook_url` gets each item’s result the same way, then the batch when it ends or pauses. `X-FetchX-Event` says which: `fetch.finished`, `batch.finished` or `batch.paused`.' },
          { kind: 'text', text: 'Each delivery carries `X-FetchX-Timestamp` and `X-FetchX-Signature: sha256=<hex>`, an HMAC-SHA256 over `<timestamp>.<raw body>` with your project’s webhook secret (in the console). Reject deliveries whose signature does not match or whose timestamp is more than 5 minutes old.' },
          { kind: 'code', title: 'Verify a delivery', snippets: [{ label: 'Node.js', language: 'javascript', code: `import {createHmac, timingSafeEqual} from 'node:crypto';

export function verify(rawBody, headers, secret) {
  const timestamp = headers['x-fetchx-timestamp'];
  const expected = 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
  const given = String(headers['x-fetchx-signature'] ?? '');
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}` }] },
        ],
      },
    ],
  },
  {
    slug: 'reference',
    title: 'API reference',
    description: 'Every endpoint, its key scope, and the OpenAPI contract.',
    group: 'API reference',
    sections: [
      {
        id: 'endpoints',
        title: 'Endpoints',
        blocks: [
          { kind: 'text', text: '`/v1` is the only version. Every change is in the changelog at https://fetchx.ai/changelog; a breaking change is announced there as a deprecation at least 30 days before the route is retired. `GET /v1/status` and `GET /v1/prices` need no API key.' },
          { kind: 'table', headers: ['Method and path', 'Key scope', 'Purpose'], rows: contractOperations.map(operation => [
            '`' + operation.method + ' ' + operation.path + '`', scopeText(operation.scope), operation.summary]) },
          openApiLink,
          { kind: 'link', label: 'JavaScript and Python clients', href: 'https://github.com/karthikbala/FetchX/tree/main/clients' },
        ],
      },
    ],
  },
];

