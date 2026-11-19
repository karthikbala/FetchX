// The fetch service behind /v1/fetch: admission (idempotency, credits), the
// auto-mode ladder, attempts over HTTP and the browser, success-only billing,
// stored results, retention, webhooks and startup recovery.
import {randomUUID, createHmac, randomBytes} from 'node:crypto';
import {GatewayError, fail} from '../policy.mjs';
import {Sealer} from '../crypto.mjs';
import {observeSiteOutcome} from '../site-knowledge.mjs';
import {prices as priceTable, priceOf, stepFor, worstCaseOf} from '../billing/ledger.mjs';
import {parseFetchRequest, needsBrowser} from './request.mjs';
import {blockedHosts, checkAddresses, checkUrl} from './destination.mjs';
import {createResolver, proxyFor} from './routes.mjs';
import {createDoh, dohSettings} from './doh.mjs';
import {planLadder, nextStep, sameStep} from './ladder.mjs';
import {httpAttempt, fixHeaders} from './http-attempt.mjs';
import {browserAttempt} from './browser-attempt.mjs';
import {classifyResponse, retryAfterSeconds} from './outcome.mjs';
import {deriveOutputs} from './outputs.mjs';
import {exchange} from './transport.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 10_000_000,
  maxWireBytes: 30_000_000,
  maxDomBytes: 5_000_000,
  browserRequests: 250,
  settleMs: 750,
  syncWaitMs: 60_000,
  contentDays: 7,
  metadataDays: 90,
  inlineBodyBytes: 10_000_000,
  maxConcurrentPerProject: 10,
});
const OTHER_PROVIDER = {evomi: 'dataimpulse', dataimpulse: 'evomi'};
const TEXTUAL = /^(?:text\/|application\/(?:json|[a-z0-9.+-]+\+json|xml|[a-z0-9.+-]+\+xml|javascript|x-javascript|x-www-form-urlencoded))/i;
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'content-language', 'content-disposition', 'content-encoding',
  'cache-control', 'date', 'etag', 'expires', 'last-modified', 'location', 'retry-after', 'vary', 'server', 'x-robots-tag']);
// Errors that mean nothing reached the site on this step; the next step runs
// without using up an attempt.
const NOT_ADMITTED = new Set(['browser_capacity', 'browser_unavailable', 'provider_excluded', 'provider_account_rejected',
  'provider_target_refused']);
// Errors that mean the site may have seen the request but the outcome is not
// known. For GET and HEAD that is just a failed read; for anything else it is
// uncertain, and FetchX never sends uncertain work again.
const TRANSPORT_FAILURES = new Set(['source_timeout', 'source_transport_unknown', 'source_body_incomplete', 'source_tls_failed',
  'source_unreachable', 'too_many_redirects', 'content_decoding_failed', 'content_encoding_unsupported', 'decompression_ratio_limit']);

export async function initFetchStore(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fetch_requests (
      id uuid PRIMARY KEY,
      project text NOT NULL,
      key_id text,
      idempotency_key text NOT NULL,
      input_hash text NOT NULL,
      input bytea NOT NULL,
      host text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
      error_code text,
      credits_charged bigint NOT NULL DEFAULT 0,
      credits_max bigint,
      tags text[] NOT NULL DEFAULT '{}',
      result bytea,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      finished_at timestamptz,
      content_deleted_at timestamptz,
      UNIQUE (project, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS fetch_requests_project_created ON fetch_requests (project, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS fetch_requests_pending ON fetch_requests (created_at) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS fetch_content (
      request uuid NOT NULL REFERENCES fetch_requests (id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('body', 'screenshot', 'data')),
      body bytea NOT NULL,
      PRIMARY KEY (request, kind)
    );
    CREATE TABLE IF NOT EXISTS fetch_attempts (
      request uuid NOT NULL REFERENCES fetch_requests (id) ON DELETE CASCADE,
      n int NOT NULL,
      transport text NOT NULL,
      class text NOT NULL,
      provider text,
      country text,
      result text NOT NULL,
      code text,
      status_code int,
      wire_bytes bigint,
      captcha jsonb,
      started_at timestamptz NOT NULL,
      finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (request, n)
    );
    CREATE TABLE IF NOT EXISTS webhook_secrets (
      project text PRIMARY KEY,
      secret bytea NOT NULL,
      rotated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

const publicHeaders = headers => Object.fromEntries(Object.entries(headers ?? {})
  .filter(([name, value]) => RESPONSE_HEADERS.has(name.toLowerCase()) && (typeof value === 'string' || Array.isArray(value)))
  .map(([name, value]) => [name.toLowerCase(), (Array.isArray(value) ? value.join(', ') : value).slice(0, 2048)]));

function bodyFields(body, contentType) {
  if (TEXTUAL.test(contentType ?? '')) {
    try {
      return {body: new TextDecoder('utf-8', {fatal: true}).decode(body), body_encoding: 'utf-8'};
    } catch { /* fall through to base64 */ }
  }
  return {body: body.toString('base64'), body_encoding: 'base64'};
}

// What a failed request's caller should do next.
export function nextAction(code, {retryAfter = null, explicit = false} = {}) {
  const wait = seconds => ({retry_after_seconds: seconds});
  switch (code) {
    case 'rate_limited': return {action: 'retry_after', ...wait(retryAfter ?? 60), detail: 'The site is limiting requests. Retry with a new idempotency key after the wait.'};
    case 'cooling_down': return {action: 'retry_after', ...wait(retryAfter ?? 300), detail: 'Every route for this site is resting after recent failures. Retry after the wait.'};
    case 'blocked': return explicit
      ? {action: 'use_auto', detail: 'This route was refused. Remove `route` to let FetchX try every route, including a browser.'}
      : {action: 'retry_later', ...wait(retryAfter ?? 900), detail: 'The site refused every route FetchX was allowed to try. Retry later, or allow more with max_attempts or max_credits.'};
    case 'login_required': return {action: 'provide_credentials', detail: 'The site needs a login. Send its cookie or Authorization header.'};
    case 'site_error': return {action: 'retry_later', ...wait(retryAfter ?? 300), detail: 'The site returned a server error. Retry later.'};
    case 'unreachable': return {action: 'check_url', detail: 'The site could not be reached. Check the URL, then retry later.'};
    case 'timeout': return {action: 'raise_timeout', detail: 'Time ran out. Raise timeout_ms or send the request with async: true.'};
    case 'too_large': return {action: 'render_never', detail: 'The response is larger than the size cap. For large files, fetch without a browser (render: never).'};
    case 'uncertain': return {action: 'recover', detail: 'The outcome is unknown. Read this request again before sending new work; FetchX never resends it.'};
    case 'url_not_allowed': return {action: 'check_url', detail: 'The site resolves, or redirects, to a private or reserved address. FetchX only fetches public sites.'};
    case 'route_unavailable': return {action: 'use_auto', detail: 'No allowed route can be used for this site. Remove `route` or `country`, or allow a browser.'};
    default: return {action: 'retry_later', ...wait(retryAfter ?? 300), detail: 'Retry later with a new idempotency key.'};
  }
}

const MESSAGES = {
  blocked: 'The site refused every route FetchX was allowed to try.',
  rate_limited: 'The site is limiting requests, even after fresh IPs.',
  login_required: 'The site needs a login (HTTP 401).',
  site_error: 'The site returned a server error.',
  unreachable: 'The site could not be reached (DNS, connection or TLS).',
  cooling_down: 'Every route for this site is resting after recent failures, so nothing was sent.',
  timeout: 'The request ran out of time.',
  too_large: 'The response is larger than the size cap.',
  uncertain: 'The outcome is unknown. FetchX never resends uncertain work.',
  route_unavailable: 'No allowed route can be used for this site.',
  url_not_allowed: 'The site resolves, or redirects, to a private or reserved address.',
};

export class FetchService {
  // resolve and exchangeImpl replace DNS and the network in tests.
  constructor({store, config, ledger, solver = null, slots = null, runtime = null, resolve, exchangeImpl, limits = {}}) {
    Object.assign(this, {store, config, ledger, solver, slots, runtime, exchangeImpl});
    this.sealer = new Sealer(config.artifactKey);
    this.limits = {...DEFAULT_LIMITS, ...config.fetchLimits, ...limits};
    const doh = dohSettings(config);
    this.resolve = resolve ?? createResolver(config, {doh: doh ? createDoh(doh, exchangeImpl ? {exchangeImpl} : {}) : undefined});
    this.blocked = blockedHosts(config);
    this.running = new Map();
  }

  // ---------- admission ----------

  async submit(project, raw, {keyId = null} = {}) {
    const parsed = parseFetchRequest(raw, {blocked: this.blocked});
    const existing = await this.#byKey(project, parsed.idempotencyKey);
    if (existing) {
      if (existing.input_hash !== parsed.hash) fail('idempotency_conflict', 409);
      return this.#waitAndView(existing, parsed.request);
    }
    const {request} = parsed;
    const running = (await this.store.pool.query(`SELECT count(*)::int AS n FROM fetch_requests WHERE project = $1 AND status = 'pending'`,
      [project])).rows[0].n;
    if (running >= (this.config.projects?.[project]?.maxConcurrentRequests ?? this.limits.maxConcurrentPerProject)) {
      const error = new GatewayError('too_many_requests', 429);
      error.details = {retry_after_seconds: 5, running};
      throw error;
    }
    const url = new URL(request.url);
    const table = priceTable(this.config);
    // Planned without the ceiling, so a ceiling below every step is refused
    // up front; the run skips the steps the reservation cannot pay for.
    const plan = await planLadder({config: this.config, pool: this.store.pool, request, host: url.hostname, prices: table,
      reservation: null});
    const id = randomUUID();
    const metered = this.ledger.metered(project);
    let reservation = null;
    if (metered && plan.steps.length) {
      const costs = plan.steps.map(step => stepFor(step));
      const minimum = Math.min(...costs.map(step => table[step]));
      const worst = Math.max(...costs.map(step => worstCaseOf(table, step, {captcha: request.method === 'GET',
        maxWireBytes: this.limits.maxWireBytes})));
      reservation = {minimum, ceiling: Math.min(request.max_credits ?? Infinity, worst)};
      if (reservation.ceiling < minimum) {
        const error = new GatewayError('max_credits_too_low', 402);
        error.details = {min_credits: minimum};
        throw error;
      }
    }
    let inserted = false;
    await this.store.tx(async client => {
      const row = await client.query(`INSERT INTO fetch_requests (id, project, key_id, idempotency_key, input_hash, input, host, tags)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (project, idempotency_key) DO NOTHING`,
      [id, project, keyId, parsed.idempotencyKey, parsed.hash, this.sealer.seal(request), url.hostname, request.tags]);
      inserted = row.rowCount === 1;
      if (!inserted) return;
      if (reservation) {
        const reserved = await this.ledger.reserve(client, {project, request: id, ...reservation});
        await client.query('UPDATE fetch_requests SET credits_max = $2 WHERE id = $1', [id, reserved]);
      }
    });
    if (!inserted) return this.submit(project, raw, {keyId});
    const row = await this.#row(project, id);
    const run = this.#run(row, request, plan).catch(error => {
      process.stderr.write(JSON.stringify({event: 'fetch_run_failed', request: id, code: error?.code ?? null}) + '\n');
    });
    this.running.set(id, run);
    run.finally(() => this.running.delete(id));
    return this.#waitAndView(row, request);
  }

  async #waitAndView(row, request) {
    if (row.status === 'pending' && !request.async) {
      const run = this.running.get(row.id);
      if (run) {
        let timer;
        await Promise.race([run, new Promise(resolve => { timer = setTimeout(resolve, this.limits.syncWaitMs); })]);
        clearTimeout(timer);
      }
      row = await this.#row(row.project, row.id);
    }
    return this.view(row, {includeBody: request.include_body});
  }

  // ---------- the ladder ----------

  async #run(row, request, plan) {
    const url = new URL(request.url);
    const deadline = new Date(row.created_at).getTime() + request.timeout_ms;
    const table = priceTable(this.config);
    const reservation = row.credits_max === null ? null : Number(row.credits_max);
    const readOnly = request.method === 'GET' || request.method === 'HEAD';
    const maxAttempts = plan.explicit || !readOnly ? 1 : request.max_attempts;
    const fixed = request.fix_headers ? fixHeaders(request.headers) : {headers: request.headers, fixed: []};
    const tried = [];
    let dispatchedAttempts = 0;
    let lastResult = null;
    let lastResidential = null;
    let success = null;
    let seen = null;
    let failure = null;
    let retryAfter = null;
    let n = 0;
    const attemptOptions = step => ({deadline, limits: {
      max_requests: this.limits.browserRequests, max_dom_bytes: this.limits.maxDomBytes,
      max_body_bytes: this.limits.maxBodyBytes, max_wire_bytes: this.limits.maxWireBytes,
    }, waitFor: request.wait_for, screenshot: request.formats.includes('screenshot'),
    captcha: step.transport === 'browser' && !!this.solver?.settings, settleMs: this.limits.settleMs});

    if (!plan.steps.length) failure = plan.retryAfterSeconds ? 'cooling_down' : 'route_unavailable';
    while (!failure && !success && dispatchedAttempts < maxAttempts) {
      if (Date.now() >= deadline) {
        failure = 'timeout';
        break;
      }
      const step = plan.explicit ? (tried.length ? null : plan.steps[0]) : nextStep(plan, tried, lastResult);
      if (!step) break;
      const stepName = stepFor(step);
      if (reservation !== null && table[stepName] > reservation) {
        tried.push({...step, result: 'skipped', code: 'over_max_credits'});
        continue;
      }
      n++;
      const started = new Date();
      const preferProvider = step.class === 'residential' && lastResidential ? OTHER_PROVIDER[lastResidential] : null;
      let resolved;
      try {
        resolved = proxyFor(this.config, step, url.hostname, {preferProvider});
      } catch (error) {
        tried.push({...step, result: 'not_admitted', code: error.code});
        await this.#recordAttempt(row.id, n, step, {result: 'not_admitted', code: error.code, started});
        continue;
      }
      const {route, proxy} = resolved;
      let response = null;
      let result;
      let code = null;
      try {
        if (step.transport === 'http') {
          response = await httpAttempt({url, method: request.method, headers: fixed.headers,
            body: request.body_base64 ? Buffer.from(request.body_base64, 'base64') : null},
          {proxy, resolve: this.resolve, blocked: this.blocked},
          {deadline, maxBodyBytes: this.limits.maxBodyBytes, maxWireBytes: this.limits.maxWireBytes},
          this.exchangeImpl ? {exchangeImpl: this.exchangeImpl} : {});
        } else {
          response = await browserAttempt({url, headers: request.headers}, {
            config: this.config, route, proxy, resolve: this.resolve, blocked: this.blocked, slots: this.slots,
            runtime: this.runtime, solver: this.solver, ids: {request: row.id, project: row.project},
          }, attemptOptions(step));
        }
        const classified = classifyResponse({status: response.status, headers: response.headers, body: response.body},
          {transport: step.transport});
        result = classified.outcome;
        if (result === 'rate_limited') retryAfter = retryAfterSeconds(response.headers);
        // A JavaScript shell with no browser step left is still the site's answer.
        if (result === 'needs_browser' && !plan.steps.some(s => s.transport === 'browser' && !tried.some(t => sameStep(t, s)) && !sameStep(s, step))) {
          result = 'success';
        }
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        code = error.code;
        const unsent = error.dispatched === false;
        // A private address (from DNS or a redirect) ends the request on every route.
        if (code === 'url_not_allowed') result = 'url_not_allowed';
        else if (code?.startsWith('source_dns') || (code === 'source_unreachable' && unsent)) result = 'unreachable';
        else if (unsent || NOT_ADMITTED.has(code) || code?.startsWith('proxy_connect')) result = 'not_admitted';
        else if (code === 'too_large') result = 'too_large';
        else if (TRANSPORT_FAILURES.has(code) || code?.startsWith('browser_')) result = readOnly ? 'unreachable' : 'uncertain';
        else result = readOnly ? 'failed' : 'uncertain';
        response = {wire_bytes: error.wire_bytes ?? null, captcha: error.captcha ?? [], dispatched: error.dispatched};
      }
      const counted = !['not_admitted', 'skipped', 'url_not_allowed'].includes(result);
      if (counted) dispatchedAttempts++;
      if (route.class === 'residential' && counted) lastResidential = route.provider;
      const captchaSolved = (response?.captcha ?? []).some(solve => solve.outcome === 'passed');
      tried.push({...step, result, code, status_code: response?.status ?? null, ms: Date.now() - started.getTime(),
        captcha: response?.captcha?.length ? response.captcha.map(s => `${s.type}:${s.outcome}`) : undefined});
      await this.#recordAttempt(row.id, n, {...step, provider: route.provider}, {result, code, status_code: response?.status ?? null,
        wire_bytes: response?.wire_bytes ?? null, captcha: response?.captcha?.length ? response.captcha : null, started});
      // An attempt cut short by this request's own deadline says nothing about the route.
      const cutShort = !Number.isInteger(response?.status) && Date.now() >= deadline;
      if (!cutShort) this.#learn(url.hostname, step, route, result, response, retryAfter);
      lastResult = result;
      if (Number.isInteger(response?.status) && response.body) seen = {step, response};
      if (result === 'success' || result === 'answered') success = {step, route, response, captchaSolved};
      else if (['login_required', 'uncertain', 'too_large', 'url_not_allowed'].includes(result)) failure = result;
    }
    if (!success && !failure) {
      const counted = tried.filter(t => !['not_admitted', 'skipped'].includes(t.result));
      const last = counted.at(-1)?.result;
      failure = !counted.length ? (plan.retryAfterSeconds ? 'cooling_down' : 'route_unavailable')
        : Date.now() >= deadline ? 'timeout'
          : last === 'rate_limited' ? 'rate_limited' : last === 'site_error' ? 'site_error'
            : last === 'unreachable' ? 'unreachable' : last === 'failed' ? 'unreachable' : 'blocked';
    }
    await this.#finish(row, request, {plan, tried, success, seen, failure, retryAfter: retryAfter ?? plan.retryAfterSeconds,
      fixes: request.fix_headers ? fixed.fixed : [], table, reservation});
  }

  #learn(host, step, route, result, response, retryAfter) {
    const outcome = {success: 'success', answered: 'success', blocked: 'blocked', rate_limited: 'rate_limited',
      unreachable: 'unreachable'}[result];
    if (!outcome) return;
    void observeSiteOutcome(this.store, {host, execution: step.transport, route: {class: route.class, provider: route.provider === 'direct' ? '' : route.provider, country: route.country ?? ''},
      outcome, config: this.config, retryAfterSeconds: retryAfter,
      credits: null});
  }

  async #recordAttempt(request, n, step, {result, code = null, status_code = null, wire_bytes = null, captcha = null, started}) {
    await this.store.pool.query(`INSERT INTO fetch_attempts (request, n, transport, class, provider, country, result, code, status_code,
      wire_bytes, captcha, started_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [request, n, step.transport, step.class, step.provider ?? null, step.country ?? null, result, code, status_code,
      Number.isSafeInteger(wire_bytes) ? wire_bytes : null, captcha ? JSON.stringify(captcha) : null, started]);
  }

  // The summary (status, URL, type, size) stays with the request for 90 days.
  // Everything the site sent (headers, cookies, body, derived formats,
  // screenshot) is content: sealed in fetch_content and deleted after 7 days or
  // on DELETE. A failed request keeps what the site last answered, so the
  // caller can see the block page or error.
  async #finish(row, request, {plan, tried, success, seen, failure, retryAfter, fixes, table, reservation}) {
    const attempts = tried.filter(t => t.result !== 'skipped').map(t => ({
      transport: t.transport, class: t.class, country: t.country ?? null, ...(t.rotation ? {rotation: t.rotation} : {}),
      result: t.result, ...(t.code && ['not_admitted', 'failed'].includes(t.result) ? {code: t.code} : {}),
      status_code: t.status_code ?? null, ms: t.ms ?? null, ...(t.captcha ? {captcha: t.captcha} : {}),
    }));
    const skipped = [...plan.skipped, ...tried.filter(t => t.result === 'skipped')].map(s => ({
      transport: s.transport, class: s.class, country: s.country ?? null, reason: s.reason ?? s.code}));
    const answer = success ?? seen;
    let summary = null;
    let content = null;
    if (answer) {
      const {response, step} = answer;
      const contentType = response.headers['content-type'] ?? null;
      summary = {status_code: response.status, final_url: response.final_url, content_type: contentType,
        rendered: step.transport === 'browser', body_bytes: response.body.length};
      const outputs = success ? deriveOutputs({body: response.body, contentType, finalUrl: response.final_url, headers: response.headers},
        request.formats) : {};
      content = {data: {headers: publicHeaders(response.headers), cookies: response.cookies ?? [], ...outputs}, body: response.body,
        screenshot: success ? response.screenshot ?? null : null};
    }
    const result = success
      ? {status: 'succeeded', data: summary, attempts, skipped, fixes, error: null}
      : {status: 'failed', data: summary, attempts, skipped, fixes,
        error: {code: failure, message: MESSAGES[failure] ?? 'The request failed.', ...(retryAfter ? {retry_after_seconds: retryAfter} : {}),
          next: nextAction(failure, {retryAfter, explicit: plan.explicit})}};
    let charged = 0;
    if (success) {
      const price = priceOf(table, {step: stepFor(success.step), captchaSolved: success.captchaSolved, wireBytes: success.response.wire_bytes ?? 0});
      charged = reservation === null ? 0 : Math.min(price, reservation);
    }
    await this.store.tx(async client => {
      if (content) {
        const store = (kind, value) => client.query('INSERT INTO fetch_content (request, kind, body) VALUES ($1, $2, $3)',
          [row.id, kind, this.sealer.seal(value, {compress: kind === 'data'})]);
        await store('data', content.data);
        await store('body', content.body.toString('base64'));
        if (content.screenshot) await store('screenshot', content.screenshot.toString('base64'));
      }
      if (success && charged > 0) {
        charged = await this.ledger.charge(client, {project: row.project, request: row.id, step: stepFor(success.step), credits: charged,
          captcha: success.captchaSolved});
      } else await this.ledger.release(client, {request: row.id});
      await client.query(`UPDATE fetch_requests SET status = $2, error_code = $3, credits_charged = $4, result = $5, finished_at = clock_timestamp()
        WHERE id = $1 AND status = 'pending'`, [row.id, result.status, success ? null : failure, charged, this.sealer.seal(result, {compress: true})]);
    });
    if (request.webhook_url) void this.#deliver(row.project, row.id, request.webhook_url);
  }

  // ---------- reading ----------

  async #byKey(project, key) {
    return (await this.store.pool.query('SELECT * FROM fetch_requests WHERE project = $1 AND idempotency_key = $2', [project, key])).rows[0];
  }

  async #row(project, id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) fail('not_found', 404);
    const row = (await this.store.pool.query('SELECT * FROM fetch_requests WHERE id = $1 AND project = $2', [id, project])).rows[0];
    if (!row) fail('not_found', 404);
    return row;
  }

  async view(row, {includeBody = true} = {}) {
    const request = this.sealer.open(row.input);
    const base = {
      id: row.id, status: row.status, idempotency_key: row.idempotency_key, url: request.url,
      created_at: new Date(row.created_at).toISOString(), finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      tags: row.tags,
    };
    if (row.status === 'pending') {
      const attempts = (await this.store.pool.query('SELECT transport, class, country, result, status_code FROM fetch_attempts WHERE request = $1 ORDER BY n', [row.id])).rows;
      return {...base, data: null, credits: {charged: 0, max: row.credits_max === null ? null : Number(row.credits_max)}, attempts, skipped: [],
        fixes: [], error: null};
    }
    const result = this.sealer.open(row.result);
    const view = {...base, data: result.data, credits: {charged: Number(row.credits_charged), max: row.credits_max === null ? null : Number(row.credits_max)},
      attempts: result.attempts, skipped: result.skipped, fixes: result.fixes, error: result.error};
    if (!view.data) return view;
    view.data = {...view.data};
    const content = row.content_deleted_at ? {} : await this.#content(row.id);
    if (!content.data) {
      view.data.content_expired = true;
      return view;
    }
    Object.assign(view.data, content.data);
    if (includeBody && content.body) {
      if (content.body.length > this.limits.inlineBodyBytes) view.data.body_url = `/v1/fetch/${row.id}/content`;
      else Object.assign(view.data, bodyFields(content.body, view.data.content_type));
    }
    if (content.screenshot && request.formats.includes('screenshot')) view.data.screenshot = content.screenshot.toString('base64');
    return view;
  }

  async #content(id) {
    const rows = (await this.store.pool.query('SELECT kind, body FROM fetch_content WHERE request = $1', [id])).rows;
    const out = {data: null, body: null, screenshot: null};
    for (const row of rows) {
      const value = this.sealer.open(row.body);
      out[row.kind] = row.kind === 'data' ? value : Buffer.from(value, 'base64');
    }
    return out;
  }

  async get(project, id, {includeBody = true} = {}) {
    return this.view(await this.#row(project, id), {includeBody});
  }

  async content(project, id, kind = 'body') {
    const row = await this.#row(project, id);
    if (row.status === 'pending') fail('pending', 409);
    if (row.content_deleted_at) fail('content_expired', 410);
    const result = this.sealer.open(row.result);
    if (!result.data) fail('not_found', 404);
    const content = await this.#content(id);
    if (!content.data) fail('content_expired', 410);
    const body = content[kind];
    if (!body) fail('not_found', 404);
    return {body, contentType: kind === 'screenshot' ? 'image/jpeg' : result.data.content_type ?? 'application/octet-stream'};
  }

  async list(project, query = {}) {
    const allowed = ['status', 'tag', 'idempotency_key', 'since', 'limit', 'cursor'];
    for (const key of Object.keys(query)) if (!allowed.includes(key)) throw Object.assign(new GatewayError('invalid_request'), {details: {field: key, reason: 'unknown query'}});
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new GatewayError('invalid_request'), {details: {field: 'limit'}});
    if (query.status !== undefined && !['pending', 'succeeded', 'failed'].includes(query.status)) throw Object.assign(new GatewayError('invalid_request'), {details: {field: 'status'}});
    let since = null;
    if (query.since !== undefined) {
      since = new Date(query.since);
      if (Number.isNaN(since.getTime())) throw Object.assign(new GatewayError('invalid_request'), {details: {field: 'since'}});
    }
    let cursor = null;
    if (query.cursor !== undefined) {
      try {
        const [at, id] = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString('utf8'));
        cursor = {at: new Date(at), id: String(id)};
        if (Number.isNaN(cursor.at.getTime()) || !/^[0-9a-f-]{36}$/.test(cursor.id)) throw new Error('cursor');
      } catch { throw Object.assign(new GatewayError('invalid_request'), {details: {field: 'cursor'}}); }
    }
    const rows = (await this.store.pool.query(`SELECT * FROM fetch_requests WHERE project = $1
      AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR $3 = ANY(tags)) AND ($4::text IS NULL OR idempotency_key = $4)
      AND ($5::timestamptz IS NULL OR created_at > $5)
      AND ($6::timestamptz IS NULL OR (created_at, id) < ($6, $7::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $8`,
    [project, query.status ?? null, query.tag ?? null, query.idempotency_key ?? null, since, cursor?.at ?? null, cursor?.id ?? null, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const items = page.map(row => {
      const request = this.sealer.open(row.input);
      return {id: row.id, status: row.status, url: request.url, created_at: new Date(row.created_at).toISOString(),
        credits: {charged: Number(row.credits_charged)}, error_code: row.error_code, tags: row.tags, idempotency_key: row.idempotency_key};
    });
    const last = page.at(-1);
    return {items, next_cursor: rows.length > limit
      ? Buffer.from(JSON.stringify([new Date(last.created_at).toISOString(), last.id])).toString('base64url') : null};
  }

  async remove(project, id) {
    const row = await this.#row(project, id);
    if (row.status === 'pending') fail('pending', 409);
    await this.store.tx(async client => {
      await client.query('DELETE FROM fetch_content WHERE request = $1', [id]);
      await client.query('UPDATE fetch_requests SET content_deleted_at = COALESCE(content_deleted_at, now()) WHERE id = $1', [id]);
    });
  }

  // ---------- operations ----------

  // Content after `contentDays`, the record itself after `metadataDays`.
  async prune() {
    await this.store.tx(async client => {
      const expired = (await client.query(`UPDATE fetch_requests SET content_deleted_at = now()
        WHERE created_at < now() - make_interval(days => $1) AND status <> 'pending' AND content_deleted_at IS NULL RETURNING id`,
      [this.limits.contentDays])).rows.map(row => row.id);
      await client.query('DELETE FROM fetch_content WHERE request = ANY($1::uuid[])', [expired]);
    });
    await this.store.pool.query(`DELETE FROM fetch_requests WHERE created_at < now() - make_interval(days => $1) AND status <> 'pending'`,
      [this.limits.metadataDays]);
  }

  // A request still pending at startup was cut off mid-run. Its attempts may
  // have reached the site, so it is closed as uncertain and never resent; its
  // credits are released.
  async recover() {
    const rows = (await this.store.pool.query(`SELECT id, project FROM fetch_requests WHERE status = 'pending'`)).rows;
    for (const row of rows) {
      const result = {status: 'failed', data: null, attempts: [], skipped: [], fixes: [],
        error: {code: 'uncertain', message: MESSAGES.uncertain, next: nextAction('uncertain')}};
      await this.store.tx(async client => {
        await this.ledger.release(client, {request: row.id});
        await client.query(`UPDATE fetch_requests SET status = 'failed', error_code = 'uncertain', result = $2, finished_at = clock_timestamp()
          WHERE id = $1 AND status = 'pending'`, [row.id, this.sealer.seal(result)]);
      });
    }
    await this.ledger.releaseOrphans(this.store.pool, async request =>
      (await this.store.pool.query(`SELECT 1 FROM fetch_requests WHERE id = $1 AND status = 'pending'`, [request])).rowCount === 1);
    return rows.length;
  }

  async close() {
    await Promise.allSettled([...this.running.values()]);
  }

  // ---------- webhooks ----------

  async webhookSecret(project, {rotate = false} = {}) {
    const existing = (await this.store.pool.query('SELECT secret FROM webhook_secrets WHERE project = $1', [project])).rows[0];
    if (existing && !rotate) return this.sealer.open(existing.secret);
    const secret = 'whsec_' + randomBytes(24).toString('base64url');
    await this.store.pool.query(`INSERT INTO webhook_secrets (project, secret) VALUES ($1, $2)
      ON CONFLICT (project) DO UPDATE SET secret = EXCLUDED.secret, rotated_at = now()`, [project, this.sealer.seal(secret)]);
    return secret;
  }

  // POSTs the finished request (without the body) to the caller's URL, signed
  // with HMAC-SHA256 over "<timestamp>.<body>". Up to 3 tries with backoff.
  async #deliver(project, id, webhookUrl) {
    const view = await this.get(project, id, {includeBody: false});
    const body = Buffer.from(JSON.stringify(view));
    const secret = await this.webhookSecret(project);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const url = checkUrl(webhookUrl, {blocked: this.blocked});
        const addresses = checkAddresses(await this.resolve(url, {}));
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
        const response = await (this.exchangeImpl ?? exchange)({method: 'POST', headers: {'content-type': 'application/json',
          'user-agent': 'FetchX-Webhook/1', 'x-fetchx-timestamp': String(timestamp), 'x-fetchx-signature': `sha256=${signature}`}, body},
        {url, address: addresses[0].address, family: addresses[0].family}, {timeoutMs: 10_000, maxBodyBytes: 65536, maxWireBytes: 1_000_000});
        if (response.status >= 200 && response.status < 300) return true;
      } catch { /* retried below */ }
      await new Promise(resolve => setTimeout(resolve, 2000 * 4 ** attempt));
    }
    return false;
  }
}

export {needsBrowser};
