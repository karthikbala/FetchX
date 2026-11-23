// An in-memory engine that speaks the pinned contract (docs/engine-api.json)
// over HTTP, for platform tests. It fetches nothing: each job's outcome comes
// from `script(request, {allowed})`, which may return
//   {planned, step, status, error_code, page_status, challenge, captcha, wire_bytes, body, content_type, screenshot, data, hold}
// `planned` are the tiers the job would need (by default the browser tiers for
// render: always, the HTTP tiers for render: never, else every tier); when none
// is allowed the job is refused with budget_too_low, as the engine does. `step`
// (default the cheapest allowed planned tier) wins; a step outside allowed_steps
// fails the job. `hold` is a promise the job waits on before it finishes.
// `next_page` ({how, url?} or null, the default) is what the page leads on to;
// POST /internal/v1/jobs/{id}/next builds the next job's request from it (a
// link's url, else the same url) and calls `script(request, {allowed, previous})`.
// Requested formats are filled in crudely from the body (skeleton: top-level
// keys only). With `extract`, a successful job returns `extract` (default {})
// and reports `extract_tokens` (default 1000) of page text read;
// `extract_unavailable` (a reason) refuses the job with 503, as the engine does
// when extraction can't run.
// With `capture`, a job records `network` (calls as the engine stores them, by
// default the page's document and one JSON call) and is read through the
// /network routes; capture without a browser (render: never, not GET) is refused.
// Pacing: every job holds a slot on its host until it finishes; a paced job
// (JobInput.paced) is refused with host_busy when `pace(host)` ({tier,
// max_running, start_gap_ms}, default open 4 / 0 ms) leaves no free slot.
// `browserWaiting` (settable) is what POST /internal/v1/pace reports.
// test/engine-contract.test.mjs validates what it answers against the contract.
import Fastify from 'fastify';
import {createHmac, randomUUID} from 'node:crypto';

const STEPS = ['http', 'http_residential', 'browser', 'browser_residential'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = (reply, status, code, details) => reply.code(status).send({error: {code, message: code, ...(details ? {details} : {})}});
const plannedFor = request => request.render === 'always' ? STEPS.filter(step => step.startsWith('browser'))
  : request.render === 'never' ? STEPS.filter(step => step.startsWith('http')) : STEPS;
const textOf = body => body.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// Waits for a job up to `ms`, without leaving a timer behind.
const within = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};
const scrollValid = scroll => scroll === undefined || ['auto', 'off'].includes(scroll) || (Number.isInteger(scroll) && scroll >= 1 && scroll <= 50);
const canonical = value => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item));

// A crude skeleton: the top-level keys of a JSON body, the document as its sample.
function skeletonOf(body) {
  let value;
  try { value = JSON.parse(body); } catch { return null; }
  const type = item => item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
  const top = type(value) === 'object' ? Object.entries(value).map(([key, item]) => ({path: `$.${key}`, type: type(item), seen: 1,
    ...(Array.isArray(item) ? {items: item.length} : {})})) : [];
  return {bytes: Buffer.byteLength(body), root: type(value), fields: [{path: '$', type: type(value), seen: 1,
    ...(Array.isArray(value) ? {items: value.length} : {})}, ...top], sample: value, truncated: false};
}
const FORMATS = ['body', 'markdown', 'text', 'links', 'metadata', 'skeleton', 'screenshot'];
// The crude checks a fake job gets: a refusal {status, code, details} or null.
function refusalOf(request) {
  let url;
  try { url = new URL(request.url); } catch { return {status: 400, code: 'invalid_request', details: {field: 'url'}}; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || /^(10\.|127\.|localhost$)/.test(url.hostname)
    || /\bfx[ks]_[A-Za-z0-9_-]{20,}/.test(decodeURIComponent(request.url))) return {status: 400, code: 'url_not_allowed', details: {field: 'url'}};
  if (request.max_attempts !== undefined && (!Number.isInteger(request.max_attempts) || request.max_attempts < 1 || request.max_attempts > 5)) {
    return {status: 400, code: 'invalid_request', details: {field: 'max_attempts', reason: '1 to 5'}};
  }
  if (!scrollValid(request.scroll)) return {status: 400, code: 'invalid_request', details: {field: 'scroll', reason: 'auto, off, or 1 to 50'}};
  if (request.formats !== undefined && (!Array.isArray(request.formats) || request.formats.some(f => !FORMATS.includes(f)))) {
    return {status: 400, code: 'invalid_request', details: {field: 'formats'}};
  }
  if (request.capture !== undefined && request.capture !== null && request.capture !== false
    && (request.render === 'never' || (request.method ?? 'GET') !== 'GET' || (request.capture !== true && typeof request.capture !== 'object'))) {
    return {status: 400, code: 'invalid_request', details: {field: 'capture', reason: 'capture records what a browser loads: use render always or auto with GET'}};
  }
  if (typeof request.body === 'string' && Buffer.byteLength(request.body) > 1_000_000) {
    return {status: 413, code: 'request_too_large', details: {field: 'body', max_bytes: 1_000_000}};
  }
  return null;
}

// `estimates` scripts POST /internal/v1/estimates: {history: {host: SiteUsage},
// proven: {host: tier}, cooling: {host: {retry_after_seconds}}, pace: {host: Pace},
// defaults: {requests, steps}}; a request's planned tiers are plannedFor's.
export function fakeEngine({script = () => ({}), token, eventKey, estimates = {}, pace = () => ({tier: 'open', max_running: 4, start_gap_ms: 0})} = {}) {
  const jobs = new Map();
  // host -> running jobs, and when the last one started.
  const hostRunning = new Map();
  const hostStarted = new Map();
  const hostOf = request => { try { return new URL(request.url).hostname.toLowerCase(); } catch { return ''; } };
  const paceOf = host => {
    const {tier = 'open', max_running: max = 4, start_gap_ms: gap = 0} = pace(host) ?? {};
    const running = hostRunning.get(host) ?? 0;
    const last = hostStarted.get(host);
    const wait = last === undefined ? 0 : Math.max(0, last + gap - Date.now());
    return {tier, running, max_running: max, start_gap_ms: gap, next_start_in_ms: running >= max ? null : wait};
  };
  const byKey = new Map();
  const outbox = [];
  const calls = [];
  const admin = [];
  const app = Fastify({logger: false, bodyLimit: 3 * 1024 * 1024});
  const fake = {browserWaiting: 0};

  app.addHook('onRequest', async (req, reply) => {
    calls.push({method: req.method, url: req.url});
    if (req.url.startsWith('/internal/') && req.headers.authorization !== `Bearer ${token}`) return refuse(reply, 401, 'unauthorized');
  });

  const captured = job => !!job.request.capture;
  const networkView = job => ({captured: job.network.length, dropped: {trackers: 0, excluded_types: 0, third_party: 0, over_limit: 0},
    truncated: false, attempt: 1, complete: true, expires_at: new Date(Date.parse(job.created_at) + 7 * 86_400_000).toISOString(),
    expired: job.deleted, list_url: `/v1/fetch/${job.id}/network`, har_url: `/v1/fetch/${job.id}/network.har`});
  const view = (job, {includeBody = true} = {}) => {
    const base = {id: job.id, status: job.status, page_status: job.page_status ?? null, idempotency_key: job.key, url: job.request.url,
      created_at: job.created_at, finished_at: job.finished_at, tags: job.request.tags ?? []};
    if (job.status === 'pending') {
      return {...base, data: null, challenge: null, attempts: [], skipped: [], fixes: [], error: null, ...(captured(job) ? {network: null} : {})};
    }
    const data = job.data ? {...job.data} : null;
    if (data && job.deleted) data.content_expired = true;
    else if (data && includeBody && (job.request.formats ?? ['body']).includes('body')) Object.assign(data, {body: job.body, body_encoding: 'utf-8'});
    return {...base, data, challenge: job.challenge, attempts: job.attempts, skipped: job.skipped, fixes: [], error: job.error,
      ...(captured(job) ? {network: networkView(job)} : {})};
  };
  const envelope = (job, options) => ({job: view(job, options), tenant: job.tenant, usage: job.usage, webhook_url: job.webhook_url,
    deadline: job.deadline});

  function finish(job, outcome, allowed) {
    const step = outcome.step ?? (outcome.planned ?? plannedFor(job.request)).find(tier => !allowed || allowed.has(tier));
    const blocked = allowed && !allowed.has(step);
    const succeeded = !blocked && (outcome.status ?? 'succeeded') === 'succeeded';
    const transport = step.startsWith('browser') ? 'browser' : 'http';
    const routeClass = step.endsWith('_residential') ? 'residential' : 'direct';
    job.status = succeeded ? 'succeeded' : 'failed';
    job.finished_at = new Date().toISOString();
    job.body = outcome.body ?? '<html><body>ok</body></html>';
    job.data = {status_code: succeeded ? 200 : 403, final_url: job.request.url, content_type: outcome.content_type ?? 'text/html; charset=utf-8',
      rendered: transport === 'browser', body_bytes: Buffer.byteLength(job.body), headers: {}, cookies: []};
    const formats = job.request.formats ?? [];
    const text = textOf(job.body);
    if (formats.includes('markdown')) job.data.markdown = text;
    if (formats.includes('text')) job.data.text = text;
    if (formats.includes('links')) job.data.links = [];
    if (formats.includes('metadata')) job.data.metadata = {title: /<title>([^<]*)<\/title>/.exec(job.body)?.[1] ?? ''};
    if (formats.includes('skeleton')) job.data.skeleton = skeletonOf(job.body);
    job.screenshot = outcome.screenshot ?? (transport === 'browser' && formats.includes('screenshot') ? Buffer.from('jpeg') : null);
    if (job.screenshot && formats.includes('screenshot')) job.data.screenshot = Buffer.from(job.screenshot).toString('base64');
    if (succeeded) {
      job.data.page = {number: job.page?.number ?? 1, previous_id: job.page?.previous ?? null, screens: 0, end: null};
      job.data.next_page = outcome.next_page ?? null;
    }
    const extracted = succeeded && job.request.extract;
    if (extracted) {
      job.data.extract = outcome.extract ?? {};
      job.data.extract_report = {status: 'complete', page_tokens: outcome.extract_tokens ?? 1000};
    }
    Object.assign(job.data, outcome.data);
    if (job.request.capture) {
      const call = (index, extra) => ({index, page: job.page?.number ?? 1, phase: 'load', type: 'fetch', frame: 'main', method: 'GET',
        url: job.request.url, first_party: true, status: 200, status_text: 'OK', content_type: 'application/json', request_bytes: 0,
        response_bytes: 0, started_ms: index * 10, duration_ms: 5, request_headers: [['accept', '*/*']], request_body: null,
        response_headers: [['content-type', 'application/json']], body: null, body_truncated: false, body_omitted: null, flags: [],
        error: null, redirected_from: null, ...extra});
      job.network = (outcome.network ?? [{type: 'document', content_type: 'text/html', response_headers: [['content-type', 'text/html']],
        body: job.body}, {url: new URL('/api/items?page=1', job.request.url).href, body: '{"items":[{"name":"Lamp"}]}'}])
        .map((extra, n) => call(n + 1, extra)).map(entry => ({...entry, response_bytes: entry.body === null ? 0 : Buffer.byteLength(entry.body)}));
    }
    job.attempts = blocked ? [] : [{transport, class: routeClass, country: null, result: succeeded ? 'success' : 'blocked', status_code: job.data.status_code,
      wire_bytes: outcome.wire_bytes ?? 1000}];
    job.skipped = blocked ? [{transport, class: routeClass, country: null, reason: 'over_max_credits'}] : [];
    job.page_status = outcome.page_status ?? (succeeded ? 'content' : 'challenge');
    job.challenge = outcome.challenge ?? null;
    job.error = succeeded ? null : {code: outcome.error_code ?? 'blocked', message: 'The site refused every route FetchX was allowed to try.',
      next: {action: 'retry_later', retry_with_new_key: true, detail: 'Retry later.'}};
    job.usage = succeeded ? {step, captcha_solved: outcome.captcha === true, wire_bytes: outcome.wire_bytes ?? 1000,
      ...(extracted ? {extract: {page_tokens: outcome.extract_tokens ?? 1000, calls: 2}} : {})} : null;
    outbox.push(job.id);
  }

  // The envelope's own fields, checked as the engine does; a refusal is sent and null returned.
  const envelopeOf = (req, reply) => {
    const {id, tenant, request, allowed_steps: steps, wait_ms: waitMs = 60_000, paced = false} = req.body ?? {};
    if (!UUID.test(id ?? '')) { refuse(reply, 400, 'invalid_request', {field: 'id'}); return null; }
    if (typeof tenant !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(tenant)) { refuse(reply, 400, 'invalid_request', {field: 'tenant'}); return null; }
    if (!request || typeof request !== 'object' || Array.isArray(request)) { refuse(reply, 400, 'invalid_request', {field: 'request'}); return null; }
    if (steps !== undefined && steps !== null && (!Array.isArray(steps) || steps.some(step => !STEPS.includes(step)))) {
      refuse(reply, 400, 'invalid_request', {field: 'allowed_steps'});
      return null;
    }
    if (typeof paced !== 'boolean') { refuse(reply, 400, 'invalid_request', {field: 'paced'}); return null; }
    return {id, tenant, request, allowed: steps === undefined || steps === null ? null : new Set(steps), waitMs, paced};
  };
  // The job for an idempotency key, if it has one: answered (or refused) here.
  const replay = async (reply, {tenant, key, hash, async: isAsync, waitMs}) => {
    const existingId = byKey.get(`${tenant}\0${key}`);
    if (!existingId) return false;
    const existing = jobs.get(existingId);
    if (existing.hash !== hash) { refuse(reply, 409, 'idempotency_conflict'); return true; }
    if (existing.status === 'pending' && !isAsync) await within(existing.done, waitMs);
    reply.code(existing.status === 'pending' ? 202 : 200).send({...envelope(existing), created: false});
    return true;
  };
  const start = async (reply, {id, tenant, request, allowed, waitMs, key, hash, page = null, previous = null, paced = false}) => {
    if (jobs.has(id)) return refuse(reply, 409, 'job_id_conflict');
    const outcome = await script(request, {allowed: allowed ? [...allowed] : null, ...(previous ? {previous} : {})}) ?? {};
    const planned = outcome.planned ?? plannedFor(request);
    if (request.extract && outcome.extract_unavailable) return refuse(reply, 503, 'extract_unavailable', {reason: outcome.extract_unavailable});
    if (allowed && !planned.some(step => allowed.has(step))) return refuse(reply, 402, 'budget_too_low', {planned_steps: planned});
    const host = hostOf(request);
    const slot = paceOf(host);
    if (paced && slot.next_start_in_ms !== 0) {
      const wait = slot.next_start_in_ms ?? 2000;
      return refuse(reply, 429, 'host_busy', {tier: slot.tier, running: slot.running, max_running: slot.max_running, retry_after_ms: wait,
        retry_after_seconds: Math.max(1, Math.ceil(wait / 1000))});
    }
    hostRunning.set(host, (hostRunning.get(host) ?? 0) + 1);
    hostStarted.set(host, Date.now());
    const timeout = request.timeout_ms ?? 120_000;
    const job = {id, tenant, request, key, hash, page, allowed: allowed ? [...allowed] : null, status: 'pending', created_at: new Date().toISOString(),
      finished_at: null, deadline: new Date(Date.now() + timeout).toISOString(), webhook_url: request.webhook_url ?? null, usage: null, deleted: false};
    jobs.set(id, job);
    byKey.set(`${tenant}\0${key}`, id);
    job.done = Promise.resolve(outcome.hold).then(() => finish(job, outcome, allowed))
      .finally(() => hostRunning.set(host, Math.max(0, (hostRunning.get(host) ?? 1) - 1)));
    if (!request.async) await within(job.done, waitMs);
    return reply.code(job.status === 'pending' ? 202 : 200).send({...envelope(job), created: true});
  };

  app.post('/internal/v1/jobs', async (req, reply) => {
    const input = envelopeOf(req, reply);
    if (!input) return reply;
    const {request} = input;
    const refusal = refusalOf(request);
    if (refusal) return refuse(reply, refusal.status, refusal.code, refusal.code === 'url_not_allowed' ? undefined : refusal.details);
    const key = request.idempotency_key ?? `auto_${randomUUID()}`;
    const {idempotency_key: _key, ...hashed} = request;
    const hash = canonical(hashed);
    if (await replay(reply, {tenant: input.tenant, key, hash, async: request.async, waitMs: input.waitMs})) return reply;
    return start(reply, {...input, key, hash});
  });

  // The page after job :id's. Like the engine: the idempotency key first, then
  // the earlier job (the tenant's, finished, succeeded, with a next page and
  // its content); the new request keeps the earlier one's settings.
  const NEXT_FIELDS = ['scroll', 'expect', 'capture', 'max_credits', 'timeout_ms', 'async', 'webhook_url', 'idempotency_key', 'tags'];
  app.post('/internal/v1/jobs/:id/next', async (req, reply) => {
    const input = envelopeOf(req, reply);
    if (!input) return reply;
    const {request: changes} = input;
    const unknown = Object.keys(changes).find(name => !NEXT_FIELDS.includes(name));
    if (unknown) return refuse(reply, 400, 'invalid_request', {field: unknown});
    if (!scrollValid(changes.scroll)) return refuse(reply, 400, 'invalid_request', {field: 'scroll', reason: 'auto, off, or 1 to 50'});
    const previous = jobs.get(req.params.id);
    if (!previous || previous.tenant !== input.tenant) return refuse(reply, 404, 'not_found');
    const key = changes.idempotency_key ?? `auto_${randomUUID()}`;
    const {idempotency_key: _key, ...hashed} = changes;
    const hash = canonical({next_of: previous.id, ...hashed});
    const isAsync = changes.async ?? previous.request.async;
    if (await replay(reply, {tenant: input.tenant, key, hash, async: isAsync, waitMs: input.waitMs})) {
      return reply;
    }
    if (previous.status === 'pending') return refuse(reply, 409, 'pending');
    if (previous.status !== 'succeeded') return refuse(reply, 409, 'no_next_page', {reason: 'failed'});
    const next = previous.data.next_page;
    if (!next) return refuse(reply, 409, 'no_next_page', {reason: 'none_found'});
    if (previous.deleted) return refuse(reply, 410, 'content_expired');
    if (next.how === 'scroll' && (changes.scroll ?? previous.request.scroll) === 'off') {
      return refuse(reply, 400, 'invalid_request', {field: 'scroll', reason: 'this next page loads as the page is scrolled; use auto or a number of screens'});
    }
    const {idempotency_key: _old, max_credits: _credits, ...kept} = previous.request;
    const request = {...kept, ...hashed, url: next.how === 'link' ? next.url : previous.request.url};
    return start(reply, {...input, request, key, hash, page: {previous: previous.id, number: (previous.page?.number ?? 1) + 1},
      previous: previous.id});
  });

  const own = (req, reply) => {
    const tenant = req.query?.tenant;
    if (typeof tenant !== 'string') { refuse(reply, 400, 'invalid_request', {field: 'tenant'}); return null; }
    const job = jobs.get(req.params.id);
    if (!job || job.tenant !== tenant) { refuse(reply, 404, 'not_found'); return null; }
    return job;
  };
  app.get('/internal/v1/jobs', async (req, reply) => {
    const {tenant, limit = '25', idempotency_key: key, tag, status} = req.query ?? {};
    if (typeof tenant !== 'string') return refuse(reply, 400, 'invalid_request', {field: 'tenant'});
    const items = [...jobs.values()].filter(job => job.tenant === tenant && (!key || job.key === key) && (!status || job.status === status)
      && (!tag || (job.request.tags ?? []).includes(tag))).reverse().slice(0, Number(limit))
      .map(job => ({id: job.id, status: job.status, url: job.request.url, created_at: job.created_at, error_code: job.error?.code ?? null,
        tags: job.request.tags ?? [], idempotency_key: job.key}));
    return {items, next_cursor: null};
  });
  app.get('/internal/v1/jobs/:id', async (req, reply) => {
    const job = own(req, reply);
    if (!job) return reply;
    return reply.code(job.status === 'pending' ? 202 : 200).send(envelope(job, {includeBody: req.query.include_body !== 'false'}));
  });
  for (const kind of ['content', 'screenshot']) {
    app.get(`/internal/v1/jobs/:id/${kind}`, async (req, reply) => {
      const job = own(req, reply);
      if (!job) return reply;
      if (job.status === 'pending') return refuse(reply, 409, 'pending');
      if (job.deleted) return refuse(reply, 410, 'content_expired');
      if (kind === 'screenshot' && !job.screenshot) return refuse(reply, 404, 'not_found');
      return reply.header('content-type', kind === 'screenshot' ? 'image/jpeg' : job.data.content_type)
        .send(kind === 'screenshot' ? job.screenshot : Buffer.from(job.body));
    });
  }
  // A job's network capture: crude filters (type, content_type, contains, limit, cursor), one call, a body, HAR.
  const capturedJob = (req, reply) => {
    const job = own(req, reply);
    if (!job) return null;
    if (!captured(job)) { refuse(reply, 404, 'capture_not_found'); return null; }
    if (job.status === 'pending') { refuse(reply, 409, 'pending'); return null; }
    if (job.deleted) { refuse(reply, 410, 'content_expired'); return null; }
    return job;
  };
  const row = ({request_headers: _a, response_headers: _b, request_body: _c, body, status_text: _d, redirected_from: _e, ...rest}) =>
    ({...rest, has_body: body !== null});
  app.get('/internal/v1/jobs/:id/network', async (req, reply) => {
    const {tenant: _tenant, type, content_type: contentType, contains, limit = '50', cursor = '0', ...rest} = req.query ?? {};
    const unknown = Object.keys(rest).find(key => !['host', 'first_party', 'status', 'page', 'phase'].includes(key));
    if (unknown) return refuse(reply, 400, 'invalid_request', {field: unknown, reason: 'unknown query'});
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) return refuse(reply, 400, 'invalid_request', {field: 'limit'});
    const job = capturedJob(req, reply);
    if (!job) return reply;
    const values = contains === undefined ? [] : [contains].flat().map(value => value.toLowerCase());
    const matching = job.network.filter(call => call.index > Number(cursor) && (!type || call.type === type)
      && (!contentType || (call.content_type ?? '').includes(contentType))
      && (!values.length || values.some(value => (call.body ?? '').toLowerCase().includes(value))));
    const items = matching.slice(0, Number(limit)).map(call => ({...row(call),
      ...(values.length ? {matched: values.filter(value => (call.body ?? '').toLowerCase().includes(value))} : {})}));
    return {items, next_cursor: matching.length > items.length ? String(items.at(-1).index) : null, network: networkView(job)};
  });
  app.get('/internal/v1/jobs/:id/network.har', async (req, reply) => {
    const job = capturedJob(req, reply);
    if (!job) return reply;
    return {log: {version: '1.2', creator: {name: 'FetchX', version: 'fake'}, pages: [], entries: job.network.map(call => ({
      startedDateTime: job.created_at, time: call.duration_ms, request: {method: call.method, url: call.url}, response: {status: call.status},
      _fetchx: {index: call.index}}))}};
  });
  const oneCall = (req, reply) => {
    const job = capturedJob(req, reply);
    if (!job) return null;
    const call = job.network.find(entry => String(entry.index) === req.params.index);
    if (!call) { refuse(reply, 404, 'not_found', {field: 'index'}); return null; }
    return call;
  };
  app.get('/internal/v1/jobs/:id/network/:index', async (req, reply) => {
    const call = oneCall(req, reply);
    if (!call) return reply;
    return {index: call.index, page: call.page, phase: call.phase, type: call.type, frame: call.frame, first_party: call.first_party,
      started_ms: call.started_ms, duration_ms: call.duration_ms, flags: call.flags, error: call.error,
      request: {method: call.method, url: call.url, headers: call.request_headers, body: null, body_encoding: null, body_bytes: 0},
      response: {status: call.status, status_text: call.status_text, headers: call.response_headers, content_type: call.content_type,
        body: call.body, body_encoding: call.body === null ? null : 'utf-8', body_bytes: call.response_bytes, transfer_bytes: call.response_bytes,
        body_truncated: false, body_omitted: call.body_omitted, body_url: null},
      redirected_from: null};
  });
  app.get('/internal/v1/jobs/:id/network/:index/body', async (req, reply) => {
    const call = oneCall(req, reply);
    if (!call) return reply;
    if (call.body === null) return refuse(reply, 404, 'not_found', {field: 'body'});
    return reply.header('content-type', call.content_type ?? 'application/octet-stream').send(Buffer.from(call.body));
  });
  app.delete('/internal/v1/jobs/:id', async (req, reply) => {
    const job = own(req, reply);
    if (!job) return reply;
    if (job.status === 'pending') return refuse(reply, 409, 'pending');
    job.deleted = true;
    return reply.code(204).send();
  });
  // A batch's checks and its hosts' pace.
  app.post('/internal/v1/requests/check', async (req, reply) => {
    const requests = req.body?.requests;
    if (!Array.isArray(requests) || !requests.length || requests.length > 1000) return refuse(reply, 400, 'invalid_request', {field: 'requests'});
    return {results: requests.map(request => {
      const refusal = refusalOf(request ?? {});
      return refusal ? {error: {code: refusal.code, details: refusal.details}} : {host: hostOf(request)};
    })};
  });
  app.post('/internal/v1/pace', async (req, reply) => {
    const hosts = req.body?.hosts;
    if (!Array.isArray(hosts) || !hosts.length || hosts.length > 500) return refuse(reply, 400, 'invalid_request', {field: 'hosts'});
    return {hosts: Object.fromEntries(hosts.map(host => [host.toLowerCase(), paceOf(host.toLowerCase())])), browser_waiting: fake.browserWaiting};
  });
  app.post('/internal/v1/estimates', async (req, reply) => {
    const requests = req.body?.requests;
    if (!Array.isArray(requests) || !requests.length || requests.length > 1000) return refuse(reply, 400, 'invalid_request', {field: 'requests'});
    const items = requests.map((request, index) => {
      let host;
      try { host = new URL(request.url).hostname; } catch { return {index, error: {code: 'invalid_request', details: {field: 'url'}}}; }
      if (/^(?:127\.|10\.|localhost$)/.test(host)) return {index, error: {code: 'url_not_allowed', details: {field: 'url'}}};
      const attempts = request.max_attempts ?? 5;
      return {index, host, plan: {steps: plannedFor(request).slice(0, attempts), proven: estimates.proven?.[host] ?? null, explicit: false,
        country: 'US', max_attempts: attempts, cooling: estimates.cooling?.[host] ?? null, skipped: []}};
    });
    const hosts = Object.fromEntries(items.filter(item => item.host).map(item => [item.host, {history: estimates.history?.[item.host] ?? null,
      pace: estimates.pace?.[item.host] ?? {tier: 'open', max_running: 4, start_gap_ms: 500}}]));
    return {items, hosts, defaults: estimates.defaults ?? {requests: 0, steps: []}};
  });
  app.get('/internal/v1/status', async () => ({service: 'FetchX engine', release: 'fake', contract: '1.8', browser: {}, captcha: {},
    events: {undelivered: outbox.length, oldest_undelivered: null}}));
  // Admin: every call is recorded. Budgets (one engine budget) and the audit
  // trail are kept in memory, enough for the platform's merged list and log;
  // anything else answers {ok, path}.
  const record = req => {
    admin.push({method: req.method, path: req.url.slice('/internal/v1/admin'.length), body: req.body ?? null, actor: req.headers['x-fetchx-actor'] ?? null});
    return req.method === 'GET' || req.headers['x-fetchx-actor'];
  };
  const budgets = new Map([['captcha.maxDailyMicroUsd', {key: 'captcha.maxDailyMicroUsd', owner: 'engine', group: 'captcha',
    unit: 'usd_micro', window: '24h', min: 0, max: 5_000_000, nullable: false, value: 2_000_000, default: 2_000_000, default_source: 'config',
    source: 'config', valid: true, version: 0, reason: null, updated_by: null, updated_at: null, used: 0}]]);
  const audit = [];
  const changeBudget = (req, reply, overridden) => {
    if (!record(req)) return refuse(reply, 400, 'actor_required');
    const budget = budgets.get(req.params.key);
    if (!budget) return refuse(reply, 404, 'budget_unknown');
    const {value, version, reason} = req.body ?? {};
    if (version !== budget.version) return refuse(reply, 409, 'budget_version_conflict');
    if (typeof reason !== 'string' || !reason.trim()) return refuse(reply, 400, 'budget_reason_required');
    if (overridden && !(Number.isSafeInteger(value) && value >= budget.min && value <= budget.max)) return refuse(reply, 400, 'budget_value_invalid');
    if (!overridden && budget.source !== 'database') return refuse(reply, 409, 'budget_not_overridden');
    const before = {value: budget.value, source: budget.source, version: budget.version};
    Object.assign(budget, overridden ? {value, source: 'database'} : {value: budget.default, source: 'config'},
      {version: budget.version + 1, reason, updated_by: req.headers['x-fetchx-actor'], updated_at: new Date().toISOString()});
    audit.push({id: `budget-${audit.length + 1}`, rule_id: `budget:${budget.key}`, action: overridden ? 'set' : 'reset', before,
      after: {value: budget.value, source: budget.source, version: budget.version}, note: reason, actor: budget.updated_by, at: budget.updated_at});
    return {budget: {...budget}};
  };
  app.get('/internal/v1/admin/budgets', async req => { record(req); return {budgets: [...budgets.values()].map(b => ({...b})), autoscaler: null}; });
  app.put('/internal/v1/admin/budgets/:key', async (req, reply) => changeBudget(req, reply, true));
  app.post('/internal/v1/admin/budgets/:key/reset', async (req, reply) => changeBudget(req, reply, false));
  app.get('/internal/v1/admin/budgets/:key/audit', async (req, reply) => {
    record(req);
    if (!budgets.has(req.params.key)) return refuse(reply, 404, 'budget_unknown');
    return {entries: audit.filter(entry => entry.rule_id === `budget:${req.params.key}`).reverse()};
  });
  app.get('/internal/v1/admin/audit', async req => { record(req); return {entries: [...audit].reverse()}; });
  app.all('/internal/v1/admin/*', async (req, reply) => {
    if (!record(req)) return refuse(reply, 400, 'actor_required');
    if (req.url.endsWith('/rules/missing')) return refuse(reply, 404, 'rule_not_found');
    return {ok: true, path: req.url.slice('/internal/v1/admin'.length)};
  });

  // fetch() over app.inject: what EngineClient sends, as HTTP.
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const response = await app.inject({method: init.method ?? 'GET', url: target.pathname + target.search, headers: init.headers, payload: init.body});
    return new Response(response.statusCode === 204 ? null : response.rawPayload, {status: response.statusCode,
      headers: {'content-type': response.headers['content-type'] ?? 'application/json'}});
  };

  // Sends the queued job.finished events to the platform's events app, signed.
  async function deliver(eventsApp, {key = eventKey, tamper = false} = {}) {
    const answers = [];
    while (outbox.length) {
      const job = jobs.get(outbox.shift());
      const body = JSON.stringify({type: 'job.finished', event_id: `evt_${job.id}`, job_id: job.id, tenant: job.tenant, status: job.status,
        error_code: job.error?.code ?? null, usage: job.usage, webhook_url: job.webhook_url, finished_at: job.finished_at});
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = 'sha256=' + createHmac('sha256', key).update(`${timestamp}.`).update(tamper ? body + ' ' : body).digest('hex');
      const response = await eventsApp.inject({method: 'POST', url: '/internal/engine-events', payload: body,
        headers: {'content-type': 'application/json', 'x-fetchx-timestamp': timestamp, 'x-fetchx-signature': signature}});
      answers.push({status: response.statusCode, body: response.json()});
    }
    return answers;
  }

  return {app, fetchImpl, jobs, outbox, calls, admin, deliver, view, envelope, fake, hostRunning};
}
