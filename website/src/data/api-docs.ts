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
const getUsage = contractOperation('getUsage');
const hostedApi = 'https://app.fetchx.ai';
const json = (value: unknown) => JSON.stringify(value, null, 2);
const openApiLink: DocBlock = { kind: 'link', label: 'OpenAPI contract (JSON)', href: '/openapi.json' };

const minimal = requestExample(createFetch, 'minimal');
const markdownRequest = requestExample(createFetch, 'markdown');
const succeeded = responseExample(createFetch, 'succeeded');
const failed = responseExample(createFetch, 'failed');
const pending = responseExample(createFetch, 'pending', '202');

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
  const blocks: DocBlock[] = [{ kind: 'text', text: '`' + operation.method + ' ' + operation.path + '` · key scope `' + operation.scope + '`.' }];
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
  ['402', '`insufficient_credits`', 'The balance is below the cheapest step this request could take. `error.details` has the balance and what is needed.'],
  ['402', '`max_credits_too_low`', '`max_credits` is below the cheapest step. Raise it to at least `error.details.min_credits`.'],
  ['402', '`payment_hold`', 'Spending is paused while a payment issue is resolved.'],
  ['403', '`api_key_scope_forbidden`', 'The key does not have the scope this endpoint needs.'],
  ['404', '`not_found`', 'No request with that id in this project.'],
  ['409', '`idempotency_conflict`', 'The `idempotency_key` was used before with a different body. Use a new key.'],
  ['413', '`request_too_large`', 'The request body is over 1 MB.'],
  ['429', '`too_many_requests`', 'The project has too many requests running. Wait `retry_after_seconds`.'],
  ['503', '`unavailable`', 'FetchX cannot take work right now. Wait and resend with the same key.'],
];
const fetchErrorRows = [
  ['`blocked`', 'The site refused every route FetchX was allowed to try: a 403, a challenge page, or a captcha that could not be solved.', '`retry_later`, or `use_auto` when `route` was set'],
  ['`rate_limited`', 'The site returned 429, even after fresh residential IPs.', '`retry_after`, with the site’s own wait'],
  ['`login_required`', 'The site returned 401.', '`provide_credentials`: send its cookie or Authorization header'],
  ['`site_error`', 'The site returned a 5xx error.', '`retry_later`'],
  ['`unreachable`', 'DNS, connection or TLS failed on every route.', '`check_url`'],
  ['`url_not_allowed`', 'The site resolves, or redirects, to a private or reserved address.', '`check_url`'],
  ['`cooling_down`', 'Every route for this site is resting after recent failures, so nothing was sent.', '`retry_after`'],
  ['`route_unavailable`', 'No allowed route can be used, for example `route` names one this service does not have.', '`use_auto`'],
  ['`timeout`', '`timeout_ms` ran out.', '`raise_timeout`, or send with `async: true`'],
  ['`too_large`', 'The response is over 10 MB, or the rendered page is over 5 MB.', '`render_never` for large files'],
  ['`uncertain`', 'The outcome is unknown, for example the connection dropped after a POST was sent.', '`recover`: read the request; FetchX never resends it'],
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
          { kind: 'text', text: 'Ask for `formats` to get markdown, plain text, links, page metadata, parsed JSON or a screenshot alongside the body.' },
          { kind: 'code', title: 'Markdown from a page that needs a browser', snippets: fetchSnippets(markdownRequest) },
        ],
      },
      {
        id: 'result',
        title: 'Read the result',
        blocks: [
          { kind: 'text', text: 'A fetch that ran answers HTTP 200 with `status: succeeded` or `status: failed`. `data` holds what the site answered, `attempts` lists every route tried, and `credits.charged` is what it cost: 0 unless it succeeded.' },
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
          { kind: 'text', text: 'Send an `idempotency_key` with each request (the SDKs add one for you). If a response is lost, send the same body with the same key: FetchX returns the first result and charges once. The same key with a different body is refused with 409.' },
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
          { kind: 'text', text: 'If `FETCHX_URL` and `FETCHX_TOKEN` are already set, go to step 2. Otherwise run the Connect helper (Node.js 24) around the agent command. It shows a link and a short code; the user signs in, enters the code and picks a project. The helper then starts the command with `FETCHX_URL` and `FETCHX_TOKEN` set. The key can send and read requests and read usage.' },
          { kind: 'code', title: 'Download the helper and connect', snippets: [{ label: 'Shell', language: 'bash', code: `curl --fail --silent --show-error --proto '=https' --output connect-client.mjs https://fetchx.ai/connect-client.mjs
node ./connect-client.mjs -- codex` }] },
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
          { kind: 'text', text: '`status: succeeded` means the site gave its real answer; check `data.markdown` or `data.body` against what the user asked for. `status: failed` comes with `error.next.action`: follow it rather than guessing. A lost response is resent with the same key and body, which returns the first result and is never charged twice. Report the outcome before doing more work.' },
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
        ],
      },
      {
        id: 'lifecycle',
        title: 'Create, rotate and revoke',
        blocks: [
          { kind: 'text', text: 'Keys are created in the console under API keys and shown once; FetchX keeps only a hash. Rotating creates a new key and revokes the old one at once. Revoking stops a key immediately. Results stay with the project and can be read with any other key that has `fetch:read`.' },
          { kind: 'text', text: 'Keep keys on your server. Never put one in browser code, a public repository, or a header sent to the site you fetch: FetchX refuses requests that contain its own keys.' },
        ],
      },
      {
        id: 'connect',
        title: 'Connect for agents and CLIs',
        blocks: [
          { kind: 'text', text: 'Connect gives a tool a key after the user approves it in the browser, without copying secrets. See the coding agent guide.' },
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
          { kind: 'text', text: 'A page whose content is drawn by JavaScript (next to no text, a page that says it needs JavaScript, or content that arrives as script data) moves straight to a browser. A 429 moves to a fresh residential IP. In a browser, Turnstile, reCAPTCHA and hCaptcha challenges (and DataDome, where enabled) are solved when they appear, for 10 credits more. `render: always` (or `wait_for`, or a screenshot) starts at step 4; `render: never` stops at step 3.' },
          { kind: 'text', text: 'Only GET and HEAD climb. Any other method gets one attempt on the first allowed route and is never resent, because it may change data on the site.' },
          { kind: 'text', text: '`fix_headers` (on by default) replaces automation User-Agents such as curl or python-requests with a browser one and adds a missing Accept and Accept-Language. Your own cookies and Authorization header are sent as given.' },
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
    slug: 'results',
    title: 'Results, files and history',
    description: 'Read a result, download its body or screenshot, list requests and delete stored content.',
    group: 'API reference',
    sections: [
      ...contractOperations.filter(operation => operation !== createFetch && operation !== getUsage).map(operationSection),
      {
        id: 'retention',
        title: 'Retention',
        blocks: [{ kind: 'text', text: 'Everything the site sent (body, headers, cookies, formats, screenshot) is stored encrypted for 7 days, or until you DELETE it. The summary, attempts and credits stay for 90 days. Reading never contacts the site and is never charged.' }],
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
          { kind: 'text', text: 'The call itself was wrong, so nothing was sent to the site and nothing was charged. The body is `{error: {code, message, details?}}`.' },
          { kind: 'table', headers: ['HTTP', 'Code', 'Meaning'], rows: requestErrorRows },
        ],
      },
      {
        id: 'fetch-errors',
        title: 'Failed fetches (HTTP 200, status: failed)',
        blocks: [
          { kind: 'text', text: 'The site was tried and did not give its answer. Nothing is charged. `error.next.action` is meant for programs: act on it rather than on the message. `data` holds what the site last answered, such as the block page.' },
          { kind: 'table', headers: ['Code', 'What happened', 'next.action'], rows: fetchErrorRows },
          { kind: 'text', text: 'With `route` set there is exactly one attempt, so the error is precise about that route and suggests auto mode.' },
        ],
      },
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
          { kind: 'text', text: 'When a request is admitted, FetchX reserves up to `max_credits` or the price of the most expensive step it might use. If the balance cannot cover the cheapest step, the request is refused with 402 before anything is sent. On success it charges the price of the step that got the data, plus 10 for a solved captcha, plus 5 per MB of residential transfer beyond the first 1 MB (HTTP) or 5 MB (browser), and releases the rest. Failed requests, uncertain ones and every earlier failed step cost nothing.' },
          { kind: 'text', text: 'Trial credits and purchased credits share one balance. Purchased credits do not expire.' },
        ],
      },
      operationSection(getUsage),
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
          { kind: 'text', text: '`/v1` is the only version. Changes within it are additive; a breaking change would come as a new version with notice.' },
          { kind: 'table', headers: ['Method and path', 'Key scope', 'Purpose'], rows: contractOperations.map(operation => [
            '`' + operation.method + ' ' + operation.path + '`', '`' + operation.scope + '`', operation.summary]) },
          openApiLink,
          { kind: 'link', label: 'JavaScript and Python clients', href: 'https://github.com/karthikbala/FetchX/tree/main/clients' },
        ],
      },
    ],
  },
];

