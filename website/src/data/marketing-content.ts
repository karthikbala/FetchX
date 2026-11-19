import { sampleSets } from './samples';

export interface ContentLink { label: string; href: string }
export interface ContentFeature { title: string; text: string }
export interface ContentFAQ { question: string; answer: string }
export interface DiagramNode { label: string; detail: string; tag?: string }
export interface ContentDiagram {
  label: string;
  title: string;
  nodes: DiagramNode[];
  note: string;
  variant: 'fetch' | 'unblock' | 'browser' | 'proxy' | 'workflow';
}
export interface ContentCode { title: string; language: 'bash' | 'json' | 'javascript'; code: string; note: string }
export interface ProductPage {
  slug: string; name: string; title: string; description: string; eyebrow: string;
  headline: string; intro: string; status: string; diagram: ContentDiagram;
  benefits: ContentFeature[]; code: ContentCode; outputs: ContentFeature[];
  faq: ContentFAQ[]; docs: ContentLink[]; relatedGuide: string;
}
export interface UseCasePage {
  slug: string; name: string; title: string; description: string;
  headline: string; intro: string; challenge: string; diagram: ContentDiagram;
  workflow: ContentFeature[]; acceptance: ContentFeature[];
  sampleTitle: string; sampleDescription: string; sample: Record<string, unknown>;
  code: ContentCode; docs: ContentLink[]; relatedGuide: string;
}
export interface GuideSection {
  id: string; title: string; paragraphs: string[];
  bullets?: string[]; table?: { headers: string[]; rows: string[][] };
  code?: ContentCode; sources?: ContentLink[];
}
export interface GuidePage {
  slug: string; name: string; title: string; description: string; category: string;
  readTime: string; answer: string; sections: GuideSection[]; related: ContentLink[];
}

const newline = '\n';
const fetchCurl = (body: Record<string, unknown>) => [
  'curl "$FETCHX_URL/v1/fetch" \\',
  '  -H "Authorization: Bearer $FETCHX_TOKEN" \\',
  "  -H 'Content-Type: application/json' \\",
  "  -d '" + JSON.stringify(body, null, 2) + "'",
].join(newline);

const mdnHTTP = { label: 'MDN: HTTP overview', href: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview' };
const mdnProxy = { label: 'MDN: proxy servers and tunneling', href: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Proxy_servers_and_tunneling' };
const mdnDOM = { label: 'MDN: the Document Object Model', href: 'https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model' };
const challengeDocs = { label: 'Cloudflare: available challenge types', href: 'https://developers.cloudflare.com/cloudflare-challenges/challenge-types/' };

export const productPages: ProductPage[] = [
  {
    slug: 'web-scraping-api',
    name: 'Web Scraping API',
    title: 'Web Scraping API — One call, the cheapest route that works | FetchX',
    description: 'Get any public URL with one API call. FetchX picks the route, moves to a browser when it must, returns HTML or markdown, and charges only when it gets the data.',
    eyebrow: '01 / WEB SCRAPING API',
    headline: 'One call.\nThe data, or a clear reason.',
    intro: 'Send a URL. FetchX finds the cheapest route that gets the site’s real answer, remembers it for next time, and tells you exactly what happened on every attempt.',
    status: 'Available · Only successful requests are charged',
    diagram: {
      label: 'REQUEST / RESPONSE',
      title: 'One call. Every attempt comes back with it.',
      variant: 'fetch',
      nodes: [
        { label: 'Your application', detail: 'URL + optional formats', tag: 'INPUT' },
        { label: 'FetchX', detail: 'HTTP → residential → browser', tag: 'AUTO MODE' },
        { label: 'Web source', detail: 'The site’s real answer', tag: 'SOURCE' },
      ],
      note: 'Body + markdown + attempts + credits charged',
    },
    benefits: [
      { title: 'Auto mode by default', text: 'FetchX starts with plain HTTP and climbs to datacenter, residential IPs and a real browser only when the site needs it. It learns what worked per site, so the next request starts there.' },
      { title: 'Pay for success only', text: 'A request is charged once, at the price of the step that got the data. Blocks, timeouts and every earlier failed attempt cost nothing.' },
      { title: 'Failures that say what to do', text: 'A failed request returns a stable error code, the site’s last answer, and a next action your program can follow: wait, add credentials, or allow a browser.' },
    ],
    code: {
      title: 'Get a page as markdown',
      language: 'bash',
      code: fetchCurl({ url: 'https://catalog.example/products/desk', formats: ['markdown', 'metadata'] }),
      note: 'Reserved example domain. Only url is required.',
    },
    outputs: [
      { title: 'The content', text: 'data.body has the page or file (base64 for binary), and formats add markdown, plain text, links, page metadata, parsed JSON or a screenshot.' },
      { title: 'Every attempt', text: 'attempts lists each route tried, with its result and the site’s status. skipped explains steps that were not tried.' },
      { title: 'Safe retries', text: 'Send an idempotency_key. If a response is lost, the same key and body return the first result and are never charged twice.' },
    ],
    faq: [
      { question: 'Do I need to choose proxies?', answer: 'No. Auto mode chooses. Set route only if you want one fixed route, for debugging or an agent that wants a precise answer about that route.' },
      { question: 'Can I get markdown or a screenshot?', answer: 'Yes. Ask for formats: markdown, text, links, metadata, json or screenshot. A screenshot needs a browser, so FetchX uses one.' },
      { question: 'Does an HTTP 200 mean the data is ready?', answer: 'Check status. A fetch that ran answers HTTP 200 with status succeeded or failed; a 404 page is the site’s real answer and counts as succeeded. Validate the content against what your application expects.' },
      { question: 'What happens with POST requests?', answer: 'Methods other than GET and HEAD get exactly one attempt and are never resent, because they may change data on the site.' },
    ],
    docs: [
      { label: 'POST /v1/fetch', href: '/docs/fetch' },
      { label: 'Errors and next steps', href: '/docs/errors' },
      { label: 'Credits and usage', href: '/docs/billing' },
    ],
    relatedGuide: 'web-scraping-api-vs-proxy',
  },
  {
    slug: 'web-unblocker',
    name: 'Web Unblocker',
    title: 'Web Unblocker — Residential IPs, a real browser and captcha solving | FetchX',
    description: 'FetchX moves past blocks automatically: fresh residential IPs on rate limits, a stealth Firefox browser for JavaScript and challenges, and captcha solving.',
    eyebrow: '02 / WEB UNBLOCKER',
    headline: 'Past the block,\nwithout the guesswork.',
    intro: 'When a site blocks a request, FetchX tries the next route on its own and tells you what happened. You set the limits: attempts, credits and time.',
    status: 'Available · Turnstile, reCAPTCHA and hCaptcha solving',
    diagram: {
      label: 'THE ESCALATION LADDER',
      title: 'Cheapest first. Stop at the real answer.',
      variant: 'unblock',
      nodes: [
        { label: 'HTTP', detail: 'Direct, then datacenter', tag: '1 CREDIT' },
        { label: 'Residential', detail: 'Fresh IP after each 429', tag: '5 CREDITS' },
        { label: 'Browser', detail: 'Camoufox + captcha solving', tag: '25 CREDITS' },
      ],
      note: 'Only the step that gets the data is charged.',
    },
    benefits: [
      { title: 'Rate limits get fresh IPs', text: 'A 429 moves the next attempt to a new residential IP, alternating between two residential networks.' },
      { title: 'A real browser when needed', text: 'Empty JavaScript shells and challenge pages move to Camoufox, a hardened Firefox, with a locale and timezone that match the exit country.' },
      { title: 'Captchas solved in place', text: 'Turnstile, reCAPTCHA and hCaptcha widgets are solved when they appear, within a budget, for 10 credits more on the successful request.' },
    ],
    code: {
      title: 'Read why a request failed',
      language: 'javascript',
      code: [
        'const response = await fetch(process.env.FETCHX_URL + "/v1/fetch", {',
        '  method: "POST",',
        '  headers: { Authorization: "Bearer " + process.env.FETCHX_TOKEN, "Content-Type": "application/json" },',
        '  body: JSON.stringify({ url: "https://catalog.example/products/desk", max_credits: 60 }),',
        '});',
        'const result = await response.json();',
        'if (result.status === "failed") {',
        '  console.log(result.error.code, result.error.next.action, result.attempts);',
        '}',
      ].join(newline),
      note: 'A failed request is never charged.',
    },
    outputs: [
      { title: 'A stable error code', text: 'blocked, rate_limited, login_required, site_error, unreachable, timeout and more, each with a next action.' },
      { title: 'The site’s last answer', text: 'data holds the last response, such as the block page, so you can see what the site said.' },
      { title: 'Learning per site', text: 'Routes that worked go first next time; routes that keep failing rest for a while instead of being retried.' },
    ],
    faq: [
      { question: 'Does FetchX get past every block?', answer: 'No service can promise that. FetchX tries every route you allow and stops with a clear reason when the site still refuses.' },
      { question: 'Can I cap the cost?', answer: 'Yes. max_credits skips steps that would cost more, and max_attempts and timeout_ms bound the work.' },
      { question: 'Are blocked requests charged?', answer: 'No. Only a successful request is charged, at the price of the step that got the data.' },
      { question: 'Which sites are off limits?', answer: 'FetchX fetches public sites only: private, local and cloud-metadata addresses are refused, and some providers are never used for some hosts, for example datacenter proxies for .gov.' },
    ],
    docs: [
      { label: 'How auto mode picks a route', href: '/docs/fetch#auto-mode' },
      { label: 'Errors and next steps', href: '/docs/errors' },
      { label: 'Credits and usage', href: '/docs/billing' },
    ],
    relatedGuide: 'what-is-a-web-unblocker',
  },
  {
    slug: 'javascript-rendering',
    name: 'JavaScript Rendering',
    title: 'JavaScript Rendering — A real browser, one option away | FetchX',
    description: 'Render JavaScript pages in a hardened Firefox browser. Wait for a selector, get the rendered HTML, markdown or a screenshot, with the same single API call.',
    eyebrow: '03 / JAVASCRIPT RENDERING',
    headline: 'The page your users see,\nnot the empty shell.',
    intro: 'Auto mode moves to a browser when a page is an empty JavaScript shell or blocks plain HTTP. Ask for one directly with render: always.',
    status: 'Available · Camoufox browser',
    diagram: {
      label: 'RENDERING',
      title: 'Load, wait, capture.',
      variant: 'browser',
      nodes: [
        { label: 'Load', detail: 'Residential IP, matching locale', tag: 'BROWSER' },
        { label: 'Wait', detail: 'Selector or fixed time', tag: 'WAIT_FOR' },
        { label: 'Capture', detail: 'HTML · markdown · screenshot', tag: 'OUTPUT' },
      ],
      note: 'A browser request costs 10 credits (25 over a residential IP), only on success.',
    },
    benefits: [
      { title: 'Wait for what matters', text: 'wait_for takes a CSS selector or a fixed time, so the capture happens when the data is on the page.' },
      { title: 'Rendered output', text: 'Get the rendered HTML, markdown, text, links or a JPEG screenshot from the same call.' },
      { title: 'Safe by design', text: 'Every browser request passes the same public-address checks as HTTP, and the browser can only reach sites through FetchX.' },
    ],
    code: {
      title: 'Render and wait for a price',
      language: 'bash',
      code: fetchCurl({ url: 'https://catalog.example/products/desk', render: 'always', wait_for: { selector: '.price' }, formats: ['markdown', 'screenshot'] }),
      note: 'Reserved example domain.',
    },
    outputs: [
      { title: 'data.rendered', text: 'True when a browser produced the result.' },
      { title: 'Screenshot', text: 'A JPEG of the viewport, inline as base64 or from /v1/fetch/{id}/screenshot.' },
      { title: 'Cookies', text: 'The cookies the page set, for multi-step flows.' },
    ],
    faq: [
      { question: 'Do I have to choose when to render?', answer: 'No. Auto mode renders when it has to. Use render: always to start in a browser, or render: never to stay on HTTP.' },
      { question: 'Can I click or type before capture?', answer: 'Not yet. Browser actions are planned; today a request loads the page, waits and captures.' },
      { question: 'Can a browser send POST requests?', answer: 'The page itself can. The request you send with a browser is always a GET.' },
    ],
    docs: [
      { label: 'POST /v1/fetch', href: '/docs/fetch' },
      { label: 'Results and screenshots', href: '/docs/results' },
    ],
    relatedGuide: 'javascript-rendering',
  },
  {
    slug: 'proxy-management',
    name: 'Proxy Management',
    title: 'Proxy Management — Datacenter and residential IPs, chosen for you | FetchX',
    description: 'FetchX runs datacenter and residential proxies behind one API. It picks the network and country per site, rotates IPs on rate limits, and pins any route you ask for.',
    eyebrow: '04 / PROXY MANAGEMENT',
    headline: 'The right IP,\nwithout running a proxy pool.',
    intro: 'FetchX chooses between direct, datacenter and residential routes per site, picks the exit country that worked before, and rotates residential IPs when a site rate-limits.',
    status: 'Available · Datacenter and residential networks',
    diagram: {
      label: 'ROUTES',
      title: 'Three routes. One request.',
      variant: 'proxy',
      nodes: [
        { label: 'Direct', detail: 'From FetchX itself', tag: 'CHEAPEST' },
        { label: 'Datacenter', detail: 'Fast, country-specific', tag: 'PROXY' },
        { label: 'Residential', detail: 'Real-home IPs, fresh per attempt', tag: 'PROXY' },
      ],
      note: 'Set country to choose the exit country, or route to pin one route.',
    },
    benefits: [
      { title: 'Country by site', text: 'FetchX uses the exit country that worked for the site before, else US. Set country to choose one.' },
      { title: 'Rotation on rate limits', text: 'A 429 gets a fresh residential IP on the next attempt, from the other residential network.' },
      { title: 'Provider rules', text: 'Some providers are never used for some hosts, for example datacenter proxies for .gov sites. Your requests never need to know.' },
    ],
    code: {
      title: 'Pin one residential route',
      language: 'bash',
      code: fetchCurl({ url: 'https://catalog.example/products/desk', route: { class: 'residential', country: 'IN' } }),
      note: 'A fixed route makes one attempt and explains exactly what happened on it.',
    },
    outputs: [
      { title: 'Which routes ran', text: 'attempts shows the transport, route class and country of each step. Providers are never named.' },
      { title: 'What it cost', text: 'credits.charged is the price of the step that worked; residential transfer adds 5 credits per MB beyond the first 1 MB (HTTP) or 5 MB (browser).' },
      { title: 'Why steps were skipped', text: 'skipped lists steps that were not tried: over max_credits, resting after failures, or excluded for that host.' },
    ],
    faq: [
      { question: 'Can I bring my own proxies?', answer: 'Not in the hosted service. Self-hosted FetchX takes your own datacenter and residential proxy credentials.' },
      { question: 'Does a residential IP guarantee access?', answer: 'No. It is one step of the ladder. If the site still refuses, auto mode moves to a browser or stops with a clear reason.' },
      { question: 'Are failed requests free?', answer: 'Yes. Only successful requests are charged.' },
    ],
    docs: [
      { label: 'How auto mode picks a route', href: '/docs/fetch#auto-mode' },
      { label: 'Credits and usage', href: '/docs/billing' },
    ],
    relatedGuide: 'web-scraping-api-vs-proxy',
  },
];

const workflowDiagram = (title: string, labels: [string, string, string], details: [string, string, string]): ContentDiagram => ({
  label: 'APPLICATION WORKFLOW', title, variant: 'workflow',
  nodes: labels.map((label, i) => ({ label, detail: details[i], tag: '0' + (i + 1) })),
  note: 'FetchX handles source transport. Your application owns discovery, parsing, validation and scheduling.',
});

export const useCasePages: UseCasePage[] = [
  {
    slug: 'ai-agents', name: 'AI Agents',
    title: 'Web Data for AI Agents — Fetch, validate, then ground | FetchX',
    description: 'Connect AI applications to inspected web responses. Keep source URLs, capture timestamps and application validation alongside the context you provide to a model.',
    headline: 'Give your agent\nsomething it can cite.',
    intro: 'Useful web context starts before the prompt. Fetch the page as markdown, verify you got the right one, and carry its URL and capture time into your application.',
    challenge: 'An agent can summarize the wrong page convincingly. A blocked response, an empty shell or a stale record should never silently become trusted context.',
    diagram: workflowDiagram('Ground answers in a checked source.', ['Fetch', 'Validate', 'Ground'], ['URL → markdown', 'Identity · fields · freshness', 'Attributed context for your model']),
    workflow: [
      { title: 'Define the source boundary', text: 'Your application decides which URLs an agent may fetch and how much it may spend, with max_credits per request and a key per agent.' },
      { title: 'Inspect before extraction', text: 'Check status, final URL and content type, and use markdown for the model. A failed result says why and what to do next, so the agent can act on it.' },
      { title: 'Build attributed context', text: 'Parse or summarize in your application. Store source_url, collected_at and the operation reference with each accepted record, then pass the relevant context to your model.' },
    ],
    acceptance: [
      { title: 'Identity', text: 'Confirm the expected product, document or entity appears in the response. A 200 status is only one input.' },
      { title: 'Freshness', text: 'Keep capture time separate from a source’s publication or update date. Define how old a record can be for this question.' },
      { title: 'Evidence', text: 'Keep the source reference and capture lineage. Test whether the generated answer is supported by the accepted content.' },
    ],
    sampleTitle: 'Context prepared by your application',
    sampleDescription: 'Synthetic example built from the existing commerce sample. The agent answer and validation fields are illustrative application output, not FetchX extraction or model features.',
    sample: {
      entity: sampleSets.commerce.records[0].title,
      facts: { price: sampleSets.commerce.records[0].price, currency: sampleSets.commerce.records[0].currency, availability: sampleSets.commerce.records[0].availability },
      source_url: sampleSets.commerce.records[0].source_url,
      collected_at: sampleSets.commerce.records[0].collected_at,
      application_validation: 'synthetic_example',
    },
    code: {
      title: 'Fetch a page as context',
      language: 'bash',
      code: fetchCurl({ url: 'https://store.example/products/tote', formats: ['markdown', 'metadata'], idempotency_key: 'agent-product-001' }),
      note: 'Reserved example domain. Retrieval, embeddings and model calls run in your application.',
    },
    docs: [{ label: 'Fetch a URL', href: '/docs/fetch' }, { label: 'FetchX for coding agents', href: '/docs/coding-agents' }, { label: 'Errors and next steps', href: '/docs/errors' }],
    relatedGuide: 'web-data-for-ai',
  },
  {
    slug: 'price-monitoring', name: 'Price Monitoring',
    title: 'Price Monitoring — Source responses for your pricing pipeline | FetchX',
    description: 'Build a price monitoring pipeline on inspected source responses. Preserve currency, availability, market context and collection time before comparing prices.',
    headline: 'A price needs\nits context.',
    intro: 'Fetch the product page your pipeline expects. Keep currency, availability, market and observation time with the price before you compare it.',
    challenge: 'The same product can have different variants, regional prices and stock states. A number without that context can trigger the wrong pricing decision.',
    diagram: workflowDiagram('Turn a page observation into a useful comparison.', ['Observe', 'Normalize', 'Compare'], ['Product + route + timestamp', 'Variant · currency · stock', 'Accepted observations only']),
    workflow: [
      { title: 'Choose a repeatable observation', text: 'Your scheduler selects a product URL, market context and cadence. Create and persist one idempotency key for each intended observation.' },
      { title: 'Validate the offer', text: 'Your parser checks product identity, variant, price, currency and availability. Keep shipping, taxes and member-only pricing separate when present.' },
      { title: 'Compare equivalent records', text: 'Store accepted observations with timestamps and source URLs. Your application decides change thresholds and sends alerts through its own integrations.' },
    ],
    acceptance: [
      { title: 'Same product', text: 'Match a stable product or variant identifier before comparing a price across observations.' },
      { title: 'Same context', text: 'Compare the same currency and market. Record stock state and any conditions attached to the displayed offer.' },
      { title: 'Same evidence trail', text: 'Retain the observation key and source URL so a price change can be traced to a particular capture.' },
    ],
    sampleTitle: 'A normalized price observation',
    sampleDescription: 'Fictional commerce data from the FetchX sample set. This shows your application’s record shape; it is not a live price or an automatically extracted API response.',
    sample: { ...sampleSets.commerce.records[0] },
    code: {
      title: 'Create one price observation',
      language: 'bash',
      code: fetchCurl({ url: 'https://store.example/products/tote', country: 'US', idempotency_key: 'price-tote-20261102-0900', tags: ['prices'] }),
      note: 'One key per observation: resending the same key after a lost response returns the first result and is charged once.',
    },
    docs: [{ label: 'POST /v1/fetch', href: '/docs/fetch' }, { label: 'Results and history', href: '/docs/results' }, { label: 'Webhooks', href: '/docs/webhooks' }],
    relatedGuide: 'web-scraping-api-vs-proxy',
  },
  {
    slug: 'real-estate', name: 'Real Estate',
    title: 'Real Estate Data — Source context for property pipelines | FetchX',
    description: 'Fetch property listings and public records for your real estate application. Preserve listing identity, units, status, source URLs and timestamps before joining records.',
    headline: 'Keep the property.\nKeep the provenance.',
    intro: 'Build property workflows from source observations you can trace. Fetch the listing or public record, validate its identity and retain the source context.',
    challenge: 'A listing, an assessment and a tax record describe different things at different times. Joining them without source identity and field meaning creates false certainty.',
    diagram: workflowDiagram('Keep source observations separate until they match.', ['Collect', 'Resolve', 'Publish'], ['Listing or public record', 'Identity · units · dates', 'Validated application records']),
    workflow: [
      { title: 'Know each source', text: 'List the listing and public-record URLs you need and what each should contain. A working listing site does not establish coverage for another registry or jurisdiction.' },
      { title: 'Parse with field meaning', text: 'Your application distinguishes asking price from assessed value, square metres from square feet, and current listing status from historical events.' },
      { title: 'Join with evidence', text: 'Match stable identifiers and retain per-source timestamps. Your application sets completeness rules and keeps partial source histories visibly incomplete.' },
    ],
    acceptance: [
      { title: 'Property identity', text: 'Check the listing, address or parcel identifier before joining observations. Similar names and addresses can refer to different records.' },
      { title: 'Units and dates', text: 'Retain currency, area units and the effective date of source values. Collection time is a separate field.' },
      { title: 'Coverage', text: 'Measure pagination and history against the source’s visible scope. A successful page fetch does not prove complete county or market coverage.' },
    ],
    sampleTitle: 'A source-attributed listing observation',
    sampleDescription: 'Fictional property data from the FetchX sample set, using a reserved example domain. Listing fields are illustrative application output, not a verified property or market feed.',
    sample: { ...sampleSets.property.records[0] },
    code: {
      title: 'Fetch a listing as markdown',
      language: 'bash',
      code: fetchCurl({ url: 'https://property.example/listings/101', formats: ['markdown'], idempotency_key: 'property-demo-101-001' }),
      note: 'Reserved example domain. Listing extraction and record matching belong to your application.',
    },
    docs: [{ label: 'POST /v1/fetch', href: '/docs/fetch' }, { label: 'How auto mode picks a route', href: '/docs/fetch#auto-mode' }, { label: 'Results and history', href: '/docs/results' }],
    relatedGuide: 'javascript-rendering',
  },
];

export const guides: GuidePage[] = [
  {
    slug: 'what-is-a-web-unblocker',
    name: 'What is a web unblocker?',
    title: 'What Is a Web Unblocker? Routes, Rendering and Limits | FetchX',
    description: 'Understand what a web unblocker does, how it differs from a proxy, and how to diagnose source blocks without confusing HTTP success with useful data.',
    category: 'FUNDAMENTALS', readTime: '6 min read',
    answer: 'A web unblocker is a service layer that helps a client obtain usable responses from web sources by coordinating access techniques such as proxy routing, sessions and browser rendering. Its actual capabilities depend on the service and the source; the name alone does not guarantee access.',
    sections: [
      {
        id: 'what-it-does', title: 'Start with the layer that failed.',
        paragraphs: [
          'A request can fail before reaching the website, at the website’s access controls, or after the page loads when your parser looks for a record. An unblocker is useful when it tries the next access path for you and tells you which of these cases you hit.',
          'HTTP exchanges have clients, responses and intermediaries. A response returned by a gateway is therefore not automatically the response you expected from the final source. Inspect the native status, final URL and body together.',
          'Some sources use interactive challenges, JavaScript checks or a separate challenge page. Cloudflare documents these as distinct challenge types. That is one reason an “unblocking” claim should be evaluated against a particular source and response, rather than a generic status code.',
        ],
        sources: [mdnHTTP, challengeDocs],
      },
      {
        id: 'components', title: 'Several tools solve different problems.',
        paragraphs: ['Treat each technique as a response to evidence. More machinery is not automatically more useful, and none of these techniques replaces validation of the resulting data.'],
        table: {
          headers: ['Technique', 'Useful when', 'What it cannot establish'],
          rows: [
            ['Proxy routing', 'The site limits or blocks some networks or countries.', 'That the page contains the expected record.'],
            ['Session continuity', 'Cookies and a stable route are needed across related requests.', 'That a lost stateful action is safe to repeat.'],
            ['Browser rendering', 'JavaScript produces the required content, or the site challenges plain HTTP.', 'That the content is complete or historically exhaustive.'],
            ['Response inspection', 'You need to separate a real page from a block or error.', 'Universal recognition of every possible challenge.'],
          ],
        },
        sources: [mdnProxy, mdnDOM],
      },
      {
        id: 'diagnose', title: 'A practical diagnostic sequence.',
        paragraphs: [
          'Consider a synthetic catalog source at catalog.example/products/desk. Your first request returns an HTML page, but the expected product ID is absent. Before changing IPs, check whether the final URL is a login page, whether the body is a challenge, or whether the initial HTML simply loads the product through JavaScript.',
          'A missing response and a rejected response are also different. If a timeout leaves dispatch uncertain, first recover the original operation. Starting a new key can repeat source work without resolving what happened to the first request.',
        ],
        bullets: [
          'Confirm the URL and method.',
          'Inspect the failure stage and whether a native source response exists.',
          'Check source identity and expected fields in the body.',
          'Move to a residential IP or a browser only when the evidence supports it; FetchX auto mode does this one step at a time.',
          'Validate the next response with the same application criteria.',
        ],
      },
      {
        id: 'fetchx', title: 'How this maps to FetchX.',
        paragraphs: [
          'FetchX auto mode climbs from plain HTTP to datacenter, residential and a browser, and stops at the site’s real answer. Every attempt is reported, and a failure comes with a stable code and a next action. Only the successful step is charged.',
          'Set route to make exactly one attempt on one route when you want a precise answer about it. Auto mode remembers what worked per site, so later requests start at that step.',
          'A useful evaluation ends with source-specific acceptance: the expected entity, fields, context and freshness are present. Neither a connected proxy nor a gateway 200 is that acceptance test.',
        ],
      },
    ],
    related: [{ label: 'Explore the Web Unblocker', href: '/products/web-unblocker' }, { label: 'Read the error reference', href: '/docs/errors' }, { label: 'How auto mode picks a route', href: '/docs/fetch#auto-mode' }],
  },
  {
    slug: 'web-scraping-api-vs-proxy',
    name: 'Web scraping API vs. proxy',
    title: 'Web Scraping API vs. Proxy — Where Each Fits | FetchX',
    description: 'Compare proxies and web scraping APIs by responsibility, session control, native responses, rendering, recovery and application validation.',
    category: 'ARCHITECTURE', readTime: '6 min read',
    answer: 'A proxy forwards network traffic. A web scraping API adds a request-and-response contract around source access, which may include routing, sessions, diagnostics, rendering or extraction. Compare the actual contract: those extra capabilities are not implied by the label.',
    sections: [
      {
        id: 'difference', title: 'The difference is responsibility.',
        paragraphs: [
          'With a proxy, your HTTP client or browser still owns the source request. You configure the intermediary, manage cookies and timeouts, inspect the response and decide what to retry. MDN describes a forward proxy as acting on behalf of a client; tunneling is a way to carry traffic through that intermediary.',
          'An API can centralize more of that work. It may authenticate projects, restrict destinations, preserve captures and return stable error fields. Some APIs also render or extract. You need to verify each capability independently, because a native fetch API and a browser extraction API expose different outputs.',
          'FetchX’s one call, POST /v1/fetch, returns the page as received plus markdown, text, links, metadata or a screenshot on request, and moves to a browser on its own when the page needs one.',
        ],
        sources: [mdnProxy],
      },
      {
        id: 'comparison', title: 'Compare the work your application still owns.',
        paragraphs: ['This comparison describes a raw forward proxy and the current FetchX contract. Other scraping APIs make different tradeoffs.'],
        table: {
          headers: ['Responsibility', 'Raw proxy', 'FetchX current API'],
          rows: [
            ['Source request', 'Your HTTP client or browser constructs it.', 'You send a URL; FetchX fixes automation headers.'],
            ['Route selection', 'Configured in your client or proxy account.', 'Auto mode per site, or one route you set.'],
            ['Cookies', 'Managed by your client.', 'Sent with the request; cookies the site sets come back with the result.'],
            ['Lost result', 'Your code decides how to reconcile it.', 'Retained same-key lookup and replay.'],
            ['Rendered page', 'You run and manage a browser.', 'render: always, or automatic when needed.'],
            ['Record validation', 'Your application.', 'Your application.'],
          ],
        },
      },
      {
        id: 'choose', title: 'Choose based on the integration boundary.',
        paragraphs: [
          'A proxy can be a good fit when you already have a reliable source client and want to own its transport details. For example, an existing catalog integration may already handle the source’s cookies, request headers and parser correctly; its missing piece is a network route the site accepts.',
          'An API becomes useful when you would rather not run proxies, browsers and captcha solving yourself. FetchX handles access and reports every attempt, while the caller handles discovery, parsing, scheduling and acceptance.',
          'For a synthetic price monitor, that means your application chooses store.example/products/tote and the observation time. FetchX returns the response and routing evidence. Your parser confirms product identity, currency and availability before it writes a price record.',
        ],
      },
      {
        id: 'request', title: 'Make the contract visible in code.',
        paragraphs: ['One call with a URL. The idempotency_key makes a resend after a lost response safe.'],
        code: {
          title: 'One request',
          language: 'bash',
          code: fetchCurl({ url: 'https://store.example/products/tote', idempotency_key: 'comparison-example-001' }),
          note: 'Reserved example domain.',
        },
      },
      {
        id: 'evaluate', title: 'Evaluate useful records and total effort.',
        paragraphs: [
          'A fair evaluation measures accepted records, traffic consumed, latency and integration effort on the sources you actually need. A cheaper request that returns an unusable page can be more expensive per accepted record.',
          'Keep bandwidth charges separate from provider invoices and application costs. Keep extraction quality separate from network success. Those distinctions make it possible to see whether a problem belongs in route selection, browser behavior or your parser.',
        ],
      },
    ],
    related: [{ label: 'Explore the Web Scraping API', href: '/products/web-scraping-api' }, { label: 'Explore proxy management', href: '/products/proxy-management' }, { label: 'Read the fetch contract', href: '/docs/fetch' }],
  },
  {
    slug: 'javascript-rendering',
    name: 'When does a page need JavaScript rendering?',
    title: 'When to Use JavaScript Rendering for Web Data | FetchX',
    description: 'Learn how native HTML differs from a rendered DOM, when browser rendering is useful, and how to define readiness and safe interaction boundaries.',
    category: 'BROWSER ENGINEERING', readTime: '7 min read',
    answer: 'Use JavaScript rendering when the content or interaction your application needs is produced in the browser and is absent from the plain HTTP response. Many useful pages do not need a browser, which is why FetchX auto mode tries HTTP first.',
    sections: [
      {
        id: 'html-dom', title: 'Native HTML and a rendered DOM are different evidence.',
        paragraphs: [
          'The native HTTP body is what the source sends for one request. A browser parses the page and can execute scripts that change its document tree. MDN defines the DOM as an in-memory representation that scripts can modify.',
          'A source may send complete product details in its initial HTML. Another may send an application shell, then fill a results list after JavaScript runs. Rendering helps with the second case, but it introduces runtime, readiness and interaction concerns that a plain HTTP request does not have.',
          'A captured DOM therefore describes page state at capture time. It is not the same artifact as the original compressed network response. Keep that distinction in storage and in downstream evidence labels.',
        ],
        sources: [mdnHTTP, mdnDOM],
      },
      {
        id: 'decision', title: 'Inspect before you render.',
        paragraphs: [
          'For a synthetic property search at property.example/search, check the initial body for the required listing IDs. If they are present and complete, HTTP may be sufficient. If the body contains only a loading shell, a browser is needed; FetchX auto mode detects such shells and moves to one.',
          'If rendering is necessary, define the state your application needs. A visible results container, a known empty-state message and the expected search context are more meaningful than an arbitrary pause.',
        ],
        table: {
          headers: ['Observed page behavior', 'Starting approach', 'Acceptance check'],
          rows: [
            ['Required records are in initial HTML', 'Native HTTP fetch', 'Entity and required fields are present.'],
            ['Page fills records after JavaScript', 'Reviewed browser render', 'Expected results or valid empty state appears.'],
            ['Search form produces the result', 'Reviewed interaction recipe', 'Submitted context and returned identity match.'],
            ['A challenge or login page appears', 'Let auto mode escalate, or send credentials', 'Do not treat the wrong page as source data.'],
          ],
        },
      },
      {
        id: 'recipe', title: 'Describe the workflow, including its boundary.',
        paragraphs: [
          'A useful render declares the URL and a readiness condition: wait_for a selector that only appears when the data has loaded, so the capture does not race the page.',
          'FetchX renders in Camoufox, a hardened Firefox, and returns the rendered HTML, markdown or a screenshot. Clicking and typing before capture are planned, not yet available.',
        ],
        code: {
          title: 'Render and wait for results',
          language: 'json',
          code: JSON.stringify({ url: 'https://catalog.example/search?q=desk', render: 'always', wait_for: { selector: '.result' }, formats: ['markdown'], idempotency_key: 'render-guide-001' }, null, 2),
          note: 'Request body for POST /v1/fetch. Reserved example domain.',
        },
      },
      {
        id: 'state', title: 'Interactions change recovery rules.',
        paragraphs: [
          'A wait observes state. A click or form submission can change it. If a response is lost after an action, the source may already have processed the action even though your client has no result.',
          'That is why FetchX never resends a request that may have changed something, such as a POST. Read the stored result and follow its outcome. Do not interpret a timeout as proof that nothing happened.',
          'For long work, send async: true and poll the request, or pass webhook_url. A succeeded request still needs application validation; it is not a statement that a product, listing or record was found.',
        ],
      },
      {
        id: 'runtime', title: 'Qualify the runtime and the source separately.',
        paragraphs: [
          'The browser runs isolated from FetchX’s own network: every request it makes passes the same public-address checks as plain HTTP and goes out through the chosen route.',
          'Finally, test the source behavior: expected records, pagination, empty states, locale and required fields. A screenshot can help explain a capture, but it does not establish complete coverage.',
        ],
      },
    ],
    related: [{ label: 'Explore JavaScript Rendering', href: '/products/javascript-rendering' }, { label: 'POST /v1/fetch', href: '/docs/fetch' }, { label: 'Webhooks', href: '/docs/webhooks' }],
  },
  {
    slug: 'web-data-for-ai',
    name: 'Preparing web data for AI',
    title: 'Preparing Web Data for AI — Source, Validate, Attribute | FetchX',
    description: 'Build an application pipeline that turns inspected web responses into attributed model context, with explicit freshness, validation and source lineage.',
    category: 'AI APPLICATIONS', readTime: '6 min read',
    answer: 'Prepare web data for AI by separating acquisition, validation, normalization and model use. Keep source URLs and capture times with accepted content, and evaluate whether the model’s answer is supported by that content. A successful fetch alone does not establish factual completeness.',
    sections: [
      {
        id: 'boundary', title: 'Give each stage one job.',
        paragraphs: [
          'A source transport layer answers a narrow question: what response did this request produce? Your parser answers a different question: which records and fields are in that response? Your application then decides whether those records are valid enough for its use case.',
          'The model is another stage. It may summarize accepted content or produce an answer from retrieved context, but it should not be the only mechanism deciding whether a challenge page, an empty shell or the wrong entity was fetched.',
          'HTTP provides resource responses, and browser scripts can change the DOM after the initial response. Choose the acquisition path that actually contains the content you need before designing the prompt.',
        ],
        sources: [mdnHTTP, mdnDOM],
      },
      {
        id: 'pipeline', title: 'A practical source-to-context pipeline.',
        paragraphs: ['Consider an assistant answering whether a synthetic store product is available. The useful evidence includes the exact product, its stock state, the source and the observation time.'],
        table: {
          headers: ['Stage', 'Responsibility', 'Persist'],
          rows: [
            ['Acquire', 'Fetch the source; get markdown for the model.', 'Request id, final URL, status, capture time.'],
            ['Validate', 'Check identity, content type and required fields.', 'Validation outcome and rejection reason.'],
            ['Normalize', 'Create a stable application record.', 'Units, currency, source URL, observation time.'],
            ['Retrieve', 'Select relevant accepted content for the question.', 'Record references and freshness criteria.'],
            ['Answer', 'Generate and evaluate an evidence-supported response.', 'Citations to the selected sources.'],
          ],
        },
      },
      {
        id: 'record', title: 'Keep provenance close to every fact.',
        paragraphs: [
          'Do not attach one vague “source” string to an entire mixed dataset. Carry the URL and collected_at value with each observation, and retain the operation reference separately in your application storage.',
          'Collection time means when your system observed a response. It does not mean the source published or updated that information at the same time. Preserve publication dates and effective dates as separate fields when the source provides them.',
        ],
        code: {
          title: 'Synthetic application record',
          language: 'json',
          code: JSON.stringify({
            title: sampleSets.commerce.records[0].title,
            availability: sampleSets.commerce.records[0].availability,
            source_url: sampleSets.commerce.records[0].source_url,
            collected_at: sampleSets.commerce.records[0].collected_at,
            validation: 'synthetic_example',
          }, null, 2),
          note: 'Fictional data from the FetchX commerce sample. This is an application record, not the native FetchX response envelope or a live availability claim.',
        },
      },
      {
        id: 'failure', title: 'Make missing evidence visible.',
        paragraphs: [
          'Decide how the application behaves when data is absent, stale or invalid. It may answer with a visible freshness caveat, ask for a narrower question or decline to make a claim. Do not silently replace a failed observation with a fresh timestamp on old content.',
          'Uncertain dispatch also deserves a defined path. Keep the original idempotency key and recover the operation before creating another source request. That protects both the evidence trail and the budget.',
          'For a property assistant, one accepted listing says nothing about all listings in a market. For a product assistant, one page does not establish an entire catalog’s availability. Define completeness at the application level and measure it against the source scope.',
        ],
      },
      {
        id: 'fetchx', title: 'Where FetchX fits.',
        paragraphs: [
          'FetchX provides source access: auto mode across routes and a browser, markdown output, every attempt reported, and safe retries. Your application owns extraction, chunking, embeddings, retrieval, model selection and answer evaluation.',
          'Structured extraction by a JSON schema is planned. Today, extraction runs in your application on the markdown or HTML FetchX returns.',
          'Start with a small set of known sources and test questions whose supporting evidence you can inspect. Expand the dataset only when source acceptance, freshness and answer support can be evaluated independently.',
        ],
      },
    ],
    related: [{ label: 'Explore AI agent workflows', href: '/use-cases/ai-agents' }, { label: 'POST /v1/fetch', href: '/docs/fetch' }, { label: 'FetchX for coding agents', href: '/docs/coding-agents' }],
  },
];

export const contentDate = '2026-11-02';
export const contentAuthor = 'FetchX engineering';
export interface MarketingPageMeta {
  path: string; title: string; description: string; kind: 'product' | 'use-case' | 'guide' | 'page';
}
export const marketingPages: MarketingPageMeta[] = [
  ...productPages.map(({ slug, title, description }) => ({ path: '/products/' + slug, title, description, kind: 'product' as const })),
  ...useCasePages.map(({ slug, title, description }) => ({ path: '/use-cases/' + slug, title, description, kind: 'use-case' as const })),
  ...guides.map(({ slug, title, description }) => ({ path: '/guides/' + slug, title, description, kind: 'guide' as const })),
  { path: '/resources', title: 'Resources — Practical Web Data Engineering | FetchX', description: 'Practical guides to web unblocking, proxies, browser rendering and preparing source-attributed web data for AI applications.', kind: 'page' },
  { path: '/about', title: 'About FetchX — Web Access API', description: 'FetchX is a web access API: one call, the cheapest route that works, and charges only for success.', kind: 'page' },
  { path: '/contact', title: 'Contact FetchX — Scope Your Source Access', description: 'Discuss your sources, access requirements and application workflow with FetchX. Start a scoped enquiry or email the FetchX team.', kind: 'page' },
];
