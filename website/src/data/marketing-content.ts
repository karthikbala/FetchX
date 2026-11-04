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
const httpCurl = (key: string, profile: string, url: string, proxyClass = 'datacenter', country: string | null = 'US') => [
  'curl "$FETCHX_URL/v2/fetch" \\',
  '  -H "Authorization: Bearer $FETCHX_TOKEN" \\',
  "  -H 'Content-Type: application/json' \\",
  "  -d '" + JSON.stringify({
    idempotency_key: key,
    access_profile: { id: profile, version: 1 },
    url,
    proxy: { class: proxyClass, country },
  }, null, 2) + "'",
].join(newline);

const mdnHTTP = { label: 'MDN: HTTP overview', href: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview' };
const mdnProxy = { label: 'MDN: proxy servers and tunneling', href: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Proxy_servers_and_tunneling' };
const mdnDOM = { label: 'MDN: the Document Object Model', href: 'https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model' };
const challengeDocs = { label: 'Cloudflare: available challenge types', href: 'https://developers.cloudflare.com/cloudflare-challenges/challenge-types/' };

export const productPages: ProductPage[] = [
  {
    slug: 'web-scraping-api',
    name: 'Web Scraping API',
    title: 'Web Scraping API — Native responses, explicit control | FetchX',
    description: 'Fetch a web page through an approved route. Get native response content, source status, diagnostics and durable recovery through the FetchX HTTP API.',
    eyebrow: '01 / WEB SCRAPING API',
    headline: 'A clean request.\nA response you can inspect.',
    intro: 'Give your application one place to fetch approved web sources. Keep the native body, the source status and the route behind every response.',
    status: 'Current HTTP API · Source access requires qualification',
    diagram: {
      label: 'REQUEST / RESPONSE',
      title: 'One call. The evidence comes back with it.',
      variant: 'fetch',
      nodes: [
        { label: 'Your application', detail: 'URL + profile + key', tag: 'INPUT' },
        { label: 'FetchX', detail: 'Approve · reserve · fetch', tag: 'GATEWAY' },
        { label: 'Web source', detail: 'Native HTTP response', tag: 'SOURCE' },
      ],
      note: 'Response body + final URL + source status + operation ID',
    },
    benefits: [
      { title: 'Keep the original context', text: 'Work with native HTML, JSON or other source bytes. Text is included when the content type and encoding support it; binary content stays available as base64.' },
      { title: 'Choose your route explicitly', text: 'Pass an approved proxy class and country with an exact profile version. Your integration can reason about the route instead of inheriting an invisible default.' },
      { title: 'Recover the same operation', text: 'Save an idempotency key before dispatch. Look up a lost response with that key instead of creating another source request.' },
    ],
    code: {
      title: 'Fetch one approved source',
      language: 'bash',
      code: httpCurl('catalog-us-001', 'catalog.http', 'https://catalog.example/products/desk'),
      note: 'Illustrative profile and reserved example domain. Configure this destination and route in an approved profile before use.',
    },
    outputs: [
      { title: 'Native content', text: 'Read data.status, data.final_url, data.content_type and data.body_base64. For supported text responses, data.text contains the decoded content.' },
      { title: 'A durable result', text: 'Keep operation_id, session_id and the idempotency key with your application record. GET /v2/fetch/:key recovers the retained operation without new source traffic.' },
      { title: 'An acceptance decision', text: 'Inspect success, error and retry guidance, then validate your expected records. application_acceptance is not_evaluated: the API does not certify your dataset.' },
    ],
    faq: [
      { question: 'Does this endpoint turn every page into structured JSON?', answer: 'POST /v2/fetch returns the source response inside a JSON envelope. Source HTML remains HTML. Your parser or application defines and validates records; reviewed browser recipes can extract configured selectors through the separate workflow API.' },
      { question: 'Can I add a render or markdown option?', answer: 'No. The current v2 fetch endpoint is HTTP only. Browser, render, formats and arbitrary extraction parameters are rejected. Use a reviewed v1 browser profile when rendering is needed.' },
      { question: 'Does an HTTP 200 mean the data is ready?', answer: 'A gateway 200 means an operation result is available. Check the independent source status, recognized challenge errors and actual page identity before accepting the data.' },
      { question: 'Can I use any URL immediately?', answer: 'The exact profile version must approve the destination, method and route. Profile discovery lists what your project can use; it does not grant unrestricted source access.' },
    ],
    docs: [
      { label: 'HTTP fetch reference', href: '/docs/fetch' },
      { label: 'Profiles and routing', href: '/docs/profiles' },
      { label: 'Recovery and idempotency', href: '/docs/recovery' },
    ],
    relatedGuide: 'web-scraping-api-vs-proxy',
  },
  {
    slug: 'web-unblocker',
    name: 'Web Unblocker',
    title: 'Web Unblocker — Understand the response before the next request | FetchX',
    description: 'Explore the FetchX web unblocking product preview: explicit routing today, with a proposed diagnosis and strategy layer for source-specific access decisions.',
    eyebrow: '02 / WEB UNBLOCKER',
    headline: 'Make the next request\nan informed one.',
    intro: 'A block is a signal, not a reason to repeat the same request forever. FetchX exposes source and transport evidence so you can choose a qualified next step.',
    status: 'Product preview · Automated diagnosis and strategy are proposed',
    diagram: {
      label: 'THE UNBLOCKING LOOP',
      title: 'Observe first. Choose a qualified strategy.',
      variant: 'unblock',
      nodes: [
        { label: 'Observe', detail: 'Status · content · failure stage', tag: 'AVAILABLE' },
        { label: 'Diagnose', detail: 'Source-specific strategy advice', tag: 'PROPOSED' },
        { label: 'Decide', detail: 'Caller-approved next request', tag: 'CONTROL' },
      ],
      note: 'Today: explicit routes and bounded known-marker detection. Proposed: AI-assisted diagnosis.',
    },
    benefits: [
      { title: 'Separate the failure layers', text: 'Distinguish gateway admission, proxy transport and a native source response. A proxy connection failure and a source denial need different investigations.' },
      { title: 'Keep route decisions visible', text: 'Choose an approved direct, datacenter or residential route. Sessions pin the country and provider so state does not drift between requests.' },
      { title: 'Build toward assisted decisions', text: 'The product direction adds AI-assisted diagnosis and strategy suggestions. This preview describes that interface; the current API does not run an inference layer or promise universal access.' },
    ],
    code: {
      title: 'Inspect a result before choosing a next step',
      language: 'javascript',
      code: [
        'const response = await fetch(',
        '  process.env.FETCHX_URL + "/v2/fetch/catalog-us-001",',
        '  { headers: { Authorization: "Bearer " + process.env.FETCHX_TOKEN } }',
        ');',
        'const result = await response.json();',
        '',
        'console.log({',
        '  state: result.state,',
        '  sourceStatus: result.data?.status,',
        '  failure: result.diagnostics?.failure,',
        '  nextAction: result.retry?.next_action,',
        '});',
        '// Follow recovery guidance. Keep an unknown dispatch on the same key.',
      ].join(newline),
      note: 'Current recovery API, not a proposed inference endpoint. A retained key must belong to the calling project.',
    },
    outputs: [
      { title: 'Current: safe diagnostics', text: 'The result can identify the failure stage, reviewed error code, source status and retained dispatch evidence. No source status is invented when the source never responded.' },
      { title: 'Current: bounded recovery', text: 'Same-key lookup and replay preserve the recorded outcome. Optional eligible HTTP retries are limited by the API contract; unknown transport outcomes do not authorize a new request.' },
      { title: 'Preview: strategy assistance', text: 'Proposed advice would connect observed evidence to a source-specific route or rendering recommendation. It would remain separate from permission, spending limits and application acceptance.' },
    ],
    faq: [
      { question: 'Does FetchX bypass every WAF or CAPTCHA?', answer: 'No. Source coverage requires qualification. The current gateway has bounded known-challenge detection and reviewed form-solving support for specific configurations. Managed Cloudflare challenges, DataDome and hCaptcha are not universally supported.' },
      { question: 'Is the AI diagnosis layer available in the API?', answer: 'No. AI-assisted diagnosis and automatic strategy selection are product preview concepts. The code examples on this page use the current fetch and recovery contract.' },
      { question: 'Will FetchX change providers after a browser action?', answer: 'No. A stateful browser action must not be replayed across providers. A timeout after a click or form submission is not permission to repeat that action.' },
      { question: 'Should every block move to residential proxies?', answer: 'No. Start with the observed failure and an approved source plan. Wrong URLs, profile restrictions, rate limits and incomplete parsing are not solved by automatically buying a more expensive route.' },
    ],
    docs: [
      { label: 'Failure codes', href: '/docs/errors' },
      { label: 'Recovery decisions', href: '/docs/recovery' },
      { label: 'Profile restrictions', href: '/docs/profiles' },
    ],
    relatedGuide: 'what-is-a-web-unblocker',
  },
  {
    slug: 'javascript-rendering',
    name: 'JavaScript Rendering',
    title: 'JavaScript Rendering — Reviewed browser workflows | FetchX',
    description: 'Render JavaScript pages with reviewed FetchX browser recipes. Define readiness, bounded interactions, selector extraction and optional PNG screenshots.',
    eyebrow: '03 / JAVASCRIPT RENDERING',
    headline: 'When the page needs\na browser, use a plan.',
    intro: 'Render the page, wait for a meaningful element and collect the configured result. Reviewed recipes keep browser interactions bounded and repeatable.',
    status: 'Separate v1 browser workflow · Runtime and source qualification required',
    diagram: {
      label: 'BROWSER RECIPE',
      title: 'Define what “ready” means for this source.',
      variant: 'browser',
      nodes: [
        { label: 'Navigate', detail: 'Approved source + runtime', tag: '01' },
        { label: 'Wait / interact', detail: 'Reviewed selectors and steps', tag: '02' },
        { label: 'Capture', detail: 'DOM · extraction · PNG', tag: '03' },
      ],
      note: 'Rendering uses reviewed v1 workflows. POST /v2/fetch remains HTTP only.',
    },
    benefits: [
      { title: 'Wait for the useful state', text: 'A source-specific ready selector gives your workflow a meaningful completion condition. Avoid treating an empty application shell as the final page.' },
      { title: 'Declare the interaction', text: 'Reviewed fill, click, select, press, wait and scroll steps accept declared variables. Callers do not send arbitrary JavaScript or connect an unrestricted CDP session.' },
      { title: 'Inspect what was captured', text: 'Read rendered HTML, configured selector outputs and optional PNG screenshots. Keep action progress with the result to understand where a workflow stopped.' },
    ],
    code: {
      title: 'Run a reviewed search recipe',
      language: 'bash',
      code: [
        'curl "$FETCHX_URL/v1/fetch" \\',
        '  -H "Authorization: Bearer $FETCHX_TOKEN" \\',
        "  -H 'Content-Type: application/json' \\",
        "  -d '{",
        '    "profile": "catalog.browser",',
        '    "url": "https://catalog.example/search",',
        '    "idempotency_key": "catalog-search-001",',
        '    "browser": {',
        '      "recipe": "search",',
        '      "values": { "query": "desk" }',
        '    }',
        "  }'",
      ].join(newline),
      note: 'The operator must configure this browser profile, its search recipe and a qualified runtime. Example domain and profile are illustrative.',
    },
    outputs: [
      { title: 'Rendered page content', text: 'Browser HTML reflects the captured DOM. It is generated page content and should not be described as an original compressed network response.' },
      { title: 'Reviewed selector values', text: 'An extract configuration produces named fields in extracted. Field names, selectors and match limits come from the server-side recipe.' },
      { title: 'Progress and evidence', text: 'actions_completed and action_step identify progress; a reviewed screenshot can provide visual context. Your application still validates the record identity and fields.' },
    ],
    faq: [
      { question: 'Can I turn on rendering with a v2 fetch flag?', answer: 'No. The one-call v2 endpoint rejects rendering parameters. Browser execution is selected by a reviewed v1 profile and recipe.' },
      { question: 'Are all browser engines ready to run?', answer: 'No. The current Camoufox pairing is blocked by a runtime qualification gate. Explicitly configured, qualified legacy CloakBrowser workflows remain a separate supported path. Check the deployment’s actual runtime before use.' },
      { question: 'Can an interaction retry on a different provider?', answer: 'Any action other than a wait prevents replay across providers. Stateful actions may have reached the source even when the response is lost; recover the retained result and follow its guidance.' },
      { question: 'When should I use jobs?', answer: 'Use the documented asynchronous job API for durable queued workflows, and when a reviewed CAPTCHA profile requires it. Poll the job and validate the nested result; a completed job does not itself mean usable data.' },
    ],
    docs: [
      { label: 'Workflow fetch and browser recipes', href: '/docs/workflow-fetch' },
      { label: 'Asynchronous jobs', href: '/docs/jobs' },
      { label: 'Recovery rules', href: '/docs/recovery' },
    ],
    relatedGuide: 'javascript-rendering',
  },
  {
    slug: 'proxy-management',
    name: 'Proxy Management',
    title: 'Proxy Management — Explicit routes, stable sessions | FetchX',
    description: 'Select approved proxy classes and countries through FetchX. Keep session routing pinned and inspect reservations, traffic accounting and recovery guidance.',
    eyebrow: '04 / PROXY MANAGEMENT',
    headline: 'Choose the route.\nKeep the context.',
    intro: 'Give proxy selection a clear contract. Set the class and country, keep a session on its pinned route, and make traffic accounting part of the response.',
    status: 'Current explicit routing · Available routes depend on configuration',
    diagram: {
      label: 'ROUTE CONTROL',
      title: 'A route is a decision your application can see.',
      variant: 'proxy',
      nodes: [
        { label: 'Approved profile', detail: 'Hosts · methods · route limits', tag: 'POLICY' },
        { label: 'Class + country', detail: 'Explicit on every new session', tag: 'CHOICE' },
        { label: 'Pinned session', detail: 'Provider + country + cookies', tag: 'CONTEXT' },
      ],
      note: 'Direct / country: null · Datacenter / approved country · Residential / approved country',
    },
    benefits: [
      { title: 'Make geography explicit', text: 'Proxy requests require an approved country code. Direct requests require country: null; direct mode does not claim a verified source country.' },
      { title: 'Preserve session continuity', text: 'A v2 session pins its profile, proxy class, country and provider. Reusing a session keeps its routing context and encrypted source cookies together.' },
      { title: 'Read cost with the outcome', text: 'Inspect conservative reservations and observed traffic separately. Customer traffic charges, provider estimates and provider invoices are different measurements.' },
    ],
    code: {
      title: 'Select an approved residential route',
      language: 'bash',
      code: httpCurl('catalog-us-res-001', 'catalog.http', 'https://catalog.example/products/desk', 'residential', 'US'),
      note: 'Residential traffic can consume budget on unsuccessful responses. Discover the approved route reservation and limits before dispatch.',
    },
    outputs: [
      { title: 'Pinned routing', text: 'routing reports the selected class, country and provider label. A configured datacenter label alone is not vendor identity or proof of source acceptance.' },
      { title: 'Traffic accounting', text: 'usage.accounting keeps conservative estimates, observed tunnel bytes and invoice fields distinct. A missing or uncertain value stays unknown instead of becoming zero.' },
      { title: 'Project boundaries', text: 'Profiles, sessions, keys and artifacts are project-scoped. A session cannot widen the approved destinations, methods, spending or response-byte limits.' },
    ],
    faq: [
      { question: 'Can I switch proxy class inside a v2 session?', answer: 'No. A session pins its route and provider. A new approved route is a new session decision, subject to the operation’s recovery state and project limits.' },
      { question: 'Does residential routing guarantee access?', answer: 'No. Network choice does not certify that a page is accessible, complete or valid for your application. Qualify each source and inspect the content.' },
      { question: 'Are failed requests free?', answer: 'No success-only billing is promised. Residential traffic can be measured on rejected or blocked pages. Read the operation’s saved charge and preserve unknown-charge holds.' },
      { question: 'Can I set a cost ceiling?', answer: 'The v2 fetch API accepts max_estimated_micro_usd. The ceiling applies to its conservative admission estimate; an unavailable estimate fails closed. It is not a provider invoice or a guarantee that usable records will be returned.' },
    ],
    docs: [
      { label: 'Profile and route discovery', href: '/docs/profiles' },
      { label: 'Fetch accounting fields', href: '/docs/fetch' },
      { label: 'Errors and admission', href: '/docs/errors' },
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
    intro: 'Useful web context starts before the prompt. Fetch approved sources, verify the page you received, and carry its URL and capture time into your application.',
    challenge: 'An agent can summarize the wrong page convincingly. A blocked response, an empty shell or a stale record should never silently become trusted context.',
    diagram: workflowDiagram('Ground answers in a checked source.', ['Fetch', 'Validate', 'Ground'], ['Approved URL + explicit route', 'Identity · fields · freshness', 'Attributed context for your model']),
    workflow: [
      { title: 'Define the source boundary', text: 'Your application chooses the URLs and approved profiles. An agent tool can accept a source identifier rather than allowing arbitrary destinations or new spending.' },
      { title: 'Inspect before extraction', text: 'Read source status, final URL, content type and native text. Route recognized blocks and unknown outcomes through recovery before sending content to a model.' },
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
      title: 'Fetch context through the current HTTP API',
      language: 'bash',
      code: httpCurl('agent-product-001', 'store.http', 'https://store.example/products/tote'),
      note: 'Source and profile are illustrative. Parsing, embeddings, retrieval and model inference run in your application; they are not v2 fetch parameters.',
    },
    docs: [{ label: 'Fetch a source', href: '/docs/fetch' }, { label: 'Constrain source access', href: '/docs/profiles' }, { label: 'Recover an uncertain result', href: '/docs/recovery' }],
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
      code: httpCurl('price-tote-20261102-0900', 'store.http', 'https://store.example/products/tote'),
      note: 'Each intended observation needs its own saved key. Recover a lost response with the same key before scheduling another source request.',
    },
    docs: [{ label: 'HTTP fetch reference', href: '/docs/fetch' }, { label: 'Session and route context', href: '/docs/profiles' }, { label: 'Durable result recovery', href: '/docs/recovery' }],
    relatedGuide: 'web-scraping-api-vs-proxy',
  },
  {
    slug: 'real-estate', name: 'Real Estate',
    title: 'Real Estate Data — Source context for property pipelines | FetchX',
    description: 'Fetch qualified property sources for your real estate application. Preserve listing identity, units, status, source URLs and timestamps before joining records.',
    headline: 'Keep the property.\nKeep the provenance.',
    intro: 'Build property workflows from source observations you can trace. Fetch the listing or public record, validate its identity and retain the source context.',
    challenge: 'A listing, an assessment and a tax record describe different things at different times. Joining them without source identity and field meaning creates false certainty.',
    diagram: workflowDiagram('Keep source observations separate until they match.', ['Collect', 'Resolve', 'Publish'], ['Qualified property source', 'Identity · units · dates', 'Validated application records']),
    workflow: [
      { title: 'Qualify each source', text: 'Define approved listing or public-record URLs, access requirements and expected content. A working listing source does not establish coverage for another registry or jurisdiction.' },
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
      title: 'Fetch an approved listing',
      language: 'bash',
      code: httpCurl('property-demo-101-001', 'property.http', 'https://property.example/listings/101'),
      note: 'This synthetic destination and profile must be replaced with an approved source configuration. Listing extraction and record matching belong to your application.',
    },
    docs: [{ label: 'HTTP fetch reference', href: '/docs/fetch' }, { label: 'Reviewed browser workflows', href: '/docs/workflow-fetch' }, { label: 'Source profiles', href: '/docs/profiles' }],
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
          'A request can fail before reaching the website, at the website’s access controls, or after the page loads when your parser looks for a record. An unblocker is useful when it gives you enough evidence to distinguish these cases and offers a qualified access path.',
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
            ['Proxy routing', 'A qualified source requires an approved network route or market context.', 'That the page contains the expected record.'],
            ['Session continuity', 'Cookies and a stable route are needed across related requests.', 'That a lost stateful action is safe to repeat.'],
            ['Browser rendering', 'JavaScript or a reviewed interaction produces the required content.', 'That the content is complete or historically exhaustive.'],
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
          'Confirm the URL, approved profile and method.',
          'Inspect the failure stage and whether a native source response exists.',
          'Check source identity and expected fields in the body.',
          'Choose a qualified route or reviewed browser workflow only when the evidence supports it.',
          'Validate the next response with the same application criteria.',
        ],
      },
      {
        id: 'fetchx', title: 'How this maps to FetchX.',
        paragraphs: [
          'The current FetchX HTTP API makes route selection explicit. Callers provide an approved profile version, proxy class, country and durable idempotency key. The result separates source status, safe diagnostics and recovery guidance from application acceptance.',
          'AI-assisted diagnosis and automatic strategy advice are a product preview. They are not current v2 fetch parameters. Today, your application makes the next-request decision using the documented contract. Reviewed browser recipes use a separate v1 API, and actual runtime readiness must be verified.',
          'A useful evaluation ends with source-specific acceptance: the expected entity, fields, context and freshness are present. Neither a connected proxy nor a gateway 200 is that acceptance test.',
        ],
      },
    ],
    related: [{ label: 'Explore the Web Unblocker preview', href: '/products/web-unblocker' }, { label: 'Read the error reference', href: '/docs/errors' }, { label: 'Understand recovery', href: '/docs/recovery' }],
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
          'FetchX’s current one-call v2 endpoint returns native HTTP content. It does not accept a render flag or a markdown output format. Reviewed browser rendering and selector extraction are separate v1 workflows.',
        ],
        sources: [mdnProxy],
      },
      {
        id: 'comparison', title: 'Compare the work your application still owns.',
        paragraphs: ['This comparison describes a raw forward proxy and the current FetchX contract. Other scraping APIs make different tradeoffs.'],
        table: {
          headers: ['Responsibility', 'Raw proxy', 'FetchX current API'],
          rows: [
            ['Source request', 'Your HTTP client or browser constructs it.', 'An approved profile and explicit request define it.'],
            ['Route selection', 'Configured in your client or proxy account.', 'Explicit proxy class and country in v2.'],
            ['Session state', 'Managed by your client.', 'V2 session pins route and encrypted cookies.'],
            ['Lost result', 'Your code decides how to reconcile it.', 'Retained same-key lookup and replay.'],
            ['Rendered page', 'You run and manage a browser.', 'Separate reviewed v1 browser workflow.'],
            ['Record validation', 'Your application.', 'Your application.'],
          ],
        },
      },
      {
        id: 'choose', title: 'Choose based on the integration boundary.',
        paragraphs: [
          'A proxy can be a good fit when you already have a reliable source client and want to own its transport details. For example, an existing catalog integration may already handle the source’s cookies, request headers and parser correctly; its missing piece is an approved route.',
          'An API becomes useful when several applications need a shared access boundary. Central profiles, project isolation, durable results and a common diagnostics shape can reduce duplicated integration code. They also make the boundary explicit: the gateway handles transport while the caller handles discovery, parsing, scheduling and acceptance.',
          'For a synthetic price monitor, that means your application chooses store.example/products/tote and the observation time. FetchX returns the response and routing evidence. Your parser confirms product identity, currency and availability before it writes a price record.',
        ],
      },
      {
        id: 'request', title: 'Make the contract visible in code.',
        paragraphs: ['This request uses the current FetchX HTTP interface. The profile, URL and route must be approved by the operator; the example does not grant source access.'],
        code: {
          title: 'One explicit HTTP request',
          language: 'bash',
          code: httpCurl('comparison-example-001', 'store.http', 'https://store.example/products/tote'),
          note: 'Synthetic destination and profile. Save the key before dispatch and recover uncertain results with the same key.',
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
    answer: 'Use JavaScript rendering when the content or interaction your application needs is produced in the browser and is absent from the native response you can obtain through an approved HTTP path. First inspect the source response; many useful pages do not need a browser.',
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
          'For a synthetic property search at property.example/search, check the initial body for the required listing IDs. If they are present and complete, HTTP may be sufficient. If the body contains only a loading shell, inspect how the permitted application presents the data and qualify an appropriate source path.',
          'If rendering is necessary, define the state your application needs. A visible results container, a known empty-state message and the expected search context are more meaningful than an arbitrary pause.',
        ],
        table: {
          headers: ['Observed page behavior', 'Starting approach', 'Acceptance check'],
          rows: [
            ['Required records are in initial HTML', 'Native HTTP fetch', 'Entity and required fields are present.'],
            ['Page fills records after JavaScript', 'Reviewed browser render', 'Expected results or valid empty state appears.'],
            ['Search form produces the result', 'Reviewed interaction recipe', 'Submitted context and returned identity match.'],
            ['A challenge or login page appears', 'Diagnose and qualify access', 'Do not treat the wrong page as source data.'],
          ],
        },
      },
      {
        id: 'recipe', title: 'Describe the workflow, including its boundary.',
        paragraphs: [
          'A useful browser recipe declares the approved URL, readiness condition and bounded interaction steps. The caller supplies only the variables declared by that recipe. This makes a search repeatable without exposing arbitrary scripts.',
          'FetchX’s v1 browser recipes support reviewed fill, select, click, press, wait and scroll actions. Selector extraction and optional PNG screenshots are configured server-side. The v2 fetch endpoint remains HTTP only.',
        ],
        code: {
          title: 'Call a reviewed recipe',
          language: 'json',
          code: JSON.stringify({ profile: 'catalog.browser', url: 'https://catalog.example/search', idempotency_key: 'render-guide-001', browser: { recipe: 'search', values: { query: 'desk' } } }, null, 2),
          note: 'Request body for POST /v1/fetch. Synthetic profile and destination; the recipe and a qualified runtime must already exist.',
        },
      },
      {
        id: 'state', title: 'Interactions change recovery rules.',
        paragraphs: [
          'A wait observes state. A click or form submission can change it. If a response is lost after an action, the source may already have processed the action even though your client has no result.',
          'That is why FetchX does not replay a stateful browser action across providers. Recover the retained workflow or capture and follow its documented outcome. Do not interpret a timeout as proof that nothing happened.',
          'For durable queued work, the job API exposes a processing state and a nested result. A completed job still needs source and application validation; completion is not a statement that a product, listing or record was found.',
        ],
      },
      {
        id: 'runtime', title: 'Qualify the runtime and the source separately.',
        paragraphs: [
          'A browser binary being installed is only one prerequisite. The gateway must also qualify its isolation, destination admission and state restoration behavior. In the current repository, the Camoufox pairing is blocked from service execution; explicitly configured qualified legacy workflows remain a separate path.',
          'Finally, test the source behavior: expected records, pagination, empty states, locale and required fields. A screenshot can help explain a capture, but it does not establish complete coverage.',
        ],
      },
    ],
    related: [{ label: 'Explore JavaScript Rendering', href: '/products/javascript-rendering' }, { label: 'Browser workflow reference', href: '/docs/workflow-fetch' }, { label: 'Jobs and polling', href: '/docs/jobs' }],
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
          'A source transport layer answers a narrow question: what response did this approved request produce? Your parser answers a different question: which records and fields are in that response? Your application then decides whether those records are valid enough for its use case.',
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
            ['Acquire', 'Fetch the approved source through an explicit route.', 'Operation reference, final URL, status, capture lineage.'],
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
          'FetchX provides the source-access boundary: approved profiles, explicit routes, native responses, diagnostics and durable result recovery. Your application owns extraction, chunking, embeddings, retrieval, model selection and answer evaluation.',
          'AI-assisted request diagnosis is a separate product preview. It should not be confused with model inference for your end-user application. Neither capability is enabled by adding an undocumented parameter to POST /v2/fetch.',
          'Start with a small set of known sources and test questions whose supporting evidence you can inspect. Expand the dataset only when source acceptance, freshness and answer support can be evaluated independently.',
        ],
      },
    ],
    related: [{ label: 'Explore AI agent workflows', href: '/use-cases/ai-agents' }, { label: 'HTTP fetch reference', href: '/docs/fetch' }, { label: 'Source profiles and limits', href: '/docs/profiles' }],
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
  { path: '/about', title: 'About FetchX — Web Access API', description: 'FetchX is a web access API built around explicit routing, durable evidence and application control.', kind: 'page' },
  { path: '/contact', title: 'Contact FetchX — Scope Your Source Access', description: 'Discuss your sources, access requirements and application workflow with FetchX. Start a scoped enquiry or email the FetchX team.', kind: 'page' },
];
