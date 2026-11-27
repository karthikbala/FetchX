// FetchX API client (Node.js 20+, Deno, Bun and browsers with fetch).
//
//   const fetchx = new FetchXClient({url: process.env.FETCHX_URL, token: process.env.FETCHX_TOKEN});
//   const result = await fetchx.fetch({url: 'https://example.com', formats: ['markdown']});
//   const page2 = result.data?.next_page ? await fetchx.nextPage(result.id) : null;
//   const batch = await fetchx.submitBatch({items: ['https://example.com/a', 'https://example.com/b'], defaults: {formats: ['markdown']}});
//   for await (const item of fetchx.batchResults(batch.id)) console.log(item.index, item.result?.status);
//
// Every POST carries an idempotency_key (generated when you leave it out), so
// the client can safely resend the same request after a lost response, a 429
// or a 503: FetchX returns the first result and never charges twice.

const RETRYABLE = new Set(['network_error', 'too_many_requests', 'unavailable', 'maintenance']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class FetchXError extends Error {
  constructor(code, {status = null, details, retryAfterSeconds = null, idempotencyKey = null, requestId = null, response = null} = {}) {
    super(code);
    this.name = 'FetchXError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
    this.idempotencyKey = idempotencyKey;
    // FetchX's id for the call (X-Request-Id): quote it when asking about one.
    this.requestId = requestId;
    this.response = response;
  }
}

export class FetchXClient {
  // retries: how many times a lost, rate-limited or unavailable POST is resent
  // with the same idempotency_key.
  constructor({url, token, fetch: transport = globalThis.fetch, timeoutMs = 130_000, retries = 2} = {}) {
    if (!url || !token) throw new FetchXError('client_config_missing');
    this.url = String(url).replace(/\/+$/, '');
    this.token = token;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  async #send(method, path, {body, raw = false, idempotencyKey = null} = {}) {
    let response;
    try {
      response = await this.transport(this.url + path, {
        method,
        headers: {authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : {'content-type': 'application/json'})},
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new FetchXError('network_error', {idempotencyKey});
    }
    if (response.status === 204) return null;
    if (raw && response.ok) {
      return {body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type')};
    }
    let data;
    try { data = await response.json(); } catch { data = null; }
    const headerId = response.headers.get('x-request-id');
    if (!isObject(data)) throw new FetchXError('invalid_response', {status: response.status, idempotencyKey, requestId: headerId});
    if (!response.ok) {
      const error = isObject(data.error) ? data.error : {};
      const retryAfter = Number(error.retry_after_seconds ?? response.headers.get('retry-after')) || null;
      throw new FetchXError(typeof error.code === 'string' ? error.code : 'request_failed',
        {status: response.status, details: error.details, retryAfterSeconds: retryAfter, idempotencyKey,
          requestId: typeof data.request_id === 'string' ? data.request_id : headerId, response: data});
    }
    return data;
  }

  // A POST that starts work, with an idempotency_key so it can be resent.
  async #start(path, input) {
    const body = {...input, idempotency_key: input.idempotency_key ?? globalThis.crypto.randomUUID()};
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#send('POST', path, {body, idempotencyKey: body.idempotency_key});
      } catch (error) {
        if (!(error instanceof FetchXError) || !RETRYABLE.has(error.code) || attempt >= this.retries) throw error;
        await sleep(Math.min(30, error.retryAfterSeconds ?? 2 ** attempt) * 1000);
      }
    }
  }

  // POST /v1/fetch. Resolves with the result: status is succeeded or failed,
  // or pending (HTTP 202) when it is still running; use wait() for those.
  async fetch(input) {
    if (!isObject(input) || typeof input.url !== 'string') throw new FetchXError('url_required');
    return this.#start('/v1/fetch', input);
  }

  // POST /v1/fetch/{id}/next: the page after a result whose data.next_page is
  // set, as a new request with its own id and its own data.next_page. input:
  // {scroll, max_credits, timeout_ms, async, webhook_url, idempotency_key, tags}.
  async nextPage(id, input = {}) {
    if (!isObject(input)) throw new FetchXError('invalid_input');
    return this.#start(`/v1/fetch/${encodeURIComponent(id)}/next`, input);
  }

  // GET /v1/fetch/{id}
  get(id, {includeBody = true} = {}) {
    return this.#send('GET', `/v1/fetch/${encodeURIComponent(id)}${includeBody ? '' : '?include_body=false'}`);
  }

  // Polls a request until it is no longer pending.
  async wait(id, {intervalMs = 2000, timeoutMs = 300_000, includeBody = true} = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.get(id, {includeBody: false});
      if (result.status !== 'pending') return includeBody ? this.get(id) : result;
      if (Date.now() + intervalMs > deadline) throw new FetchXError('wait_timeout', {response: result});
      await sleep(intervalMs);
    }
  }

  // GET /v1/fetch: {status, tag, idempotency_key, since, limit, cursor}
  list(query = {}) {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null));
    return this.#send('GET', '/v1/fetch' + (params.size ? `?${params}` : ''));
  }

  // GET /v1/fetch/{id}/content: {body: Uint8Array, contentType}
  content(id) { return this.#send('GET', `/v1/fetch/${encodeURIComponent(id)}/content`, {raw: true}); }

  // GET /v1/fetch/{id}/screenshot: {body: Uint8Array, contentType: 'image/jpeg'}
  screenshot(id) { return this.#send('GET', `/v1/fetch/${encodeURIComponent(id)}/screenshot`, {raw: true}); }

  // DELETE /v1/fetch/{id}
  async delete(id) { await this.#send('DELETE', `/v1/fetch/${encodeURIComponent(id)}`); }

  // GET /v1/fetch/{id}/network: the calls a request made with `capture`
  // recorded. query: {type, content_type, host, first_party, status, page,
  // phase, contains (a value or a list), limit, cursor}.
  network(id, query = {}) {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null)
      .flatMap(([key, value]) => [value].flat().map(item => [key, String(item)])));
    return this.#send('GET', `/v1/fetch/${encodeURIComponent(id)}/network` + (params.size ? `?${params}` : ''));
  }

  // GET /v1/fetch/{id}/network/{index}: one recorded call in full.
  networkCall(id, index) { return this.#send('GET', `/v1/fetch/${encodeURIComponent(id)}/network/${encodeURIComponent(index)}`); }

  // GET /v1/fetch/{id}/network/{index}/body: {body: Uint8Array, contentType}
  networkBody(id, index) {
    return this.#send('GET', `/v1/fetch/${encodeURIComponent(id)}/network/${encodeURIComponent(index)}/body`, {raw: true});
  }

  // GET /v1/fetch/{id}/network.har: the capture as a HAR 1.2 document. {page}
  networkHar(id, {page} = {}) {
    return this.#send('GET', `/v1/fetch/${encodeURIComponent(id)}/network.har${page === undefined ? '' : `?page=${encodeURIComponent(page)}`}`);
  }

  // POST /v1/batches: {items, defaults, webhook_url, idempotency_key, tags}.
  // Resolves with the batch at once; FetchX runs the items at each site's pace.
  async submitBatch(input) {
    if (!isObject(input) || !Array.isArray(input.items)) throw new FetchXError('items_required');
    return this.#start('/v1/batches', input);
  }

  // GET /v1/batches/{id}
  getBatch(id) { return this.#send('GET', `/v1/batches/${encodeURIComponent(id)}`); }

  // GET /v1/batches: {status, limit, cursor}
  listBatches(query = {}) {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null));
    return this.#send('GET', '/v1/batches' + (params.size ? `?${params}` : ''));
  }

  // GET /v1/batches/{id}/items: {status, order, results, limit, cursor}
  batchItems(id, query = {}) {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null));
    return this.#send('GET', `/v1/batches/${encodeURIComponent(id)}/items` + (params.size ? `?${params}` : ''));
  }

  // POST /v1/batches/{id}/cancel
  cancelBatch(id) { return this.#send('POST', `/v1/batches/${encodeURIComponent(id)}/cancel`); }

  // Yields each item of a batch once it has finished, with its result, as
  // items finish, until the batch is over (the polling alternative to a webhook).
  async *batchResults(id, {intervalMs = 5000, limit = 100, results = true} = {}) {
    let cursor = null;
    for (;;) {
      const page = await this.batchItems(id, {order: 'finished', limit, results, ...(cursor ? {cursor} : {})});
      for (const item of page.items) yield item;
      if (page.next_cursor === null) return;
      cursor = page.next_cursor;
      if (page.items.length < limit) await sleep(intervalMs);
    }
  }

  // POST /v1/estimate: what one POST /v1/fetch body, or a batch body
  // ({items, defaults}), would cost and take. Nothing is sent or reserved.
  estimate(input) { return this.#send('POST', '/v1/estimate', {body: input}); }

  // GET /v1/status: service status and notices (needs no key, but sends it).
  status() { return this.#send('GET', '/v1/status'); }

  // GET /v1/prices: what each step, a captcha, residential traffic and extraction cost in credits,
  // and the trial credits a new account gets (needs no key, but sends it).
  prices() { return this.#send('GET', '/v1/prices'); }

  // GET /v1/balance: {credits, reserved, trial, purchased, payment_hold}
  balance() { return this.#send('GET', '/v1/balance'); }

  // GET /v1/me: {project_id, key_id, key_name, key_prefix, scopes, limits}, for any valid key.
  me() { return this.#send('GET', '/v1/me'); }

  // POST /v1/feedback: report how FetchX handled a page ({fetch_id} or {url, method}, kind, message?, evidence?). Free.
  sendFeedback(input) { return this.#send('POST', '/v1/feedback', {body: input}); }

  // GET /v1/feedback/{id}: where a report stands and FetchX staff's reply.
  getFeedback(id) { return this.#send('GET', `/v1/feedback/${encodeURIComponent(id)}`); }

  // POST /v1/logins: save a site login ({site, username, password, name?}); FetchX
  // signs in with it when a page on that site asks. The password never comes back.
  saveLogin(input) { return this.#send('POST', '/v1/logins', {body: input}); }

  // GET /v1/logins: {items}, the project's saved logins (usernames masked).
  listLogins() { return this.#send('GET', '/v1/logins'); }

  // GET /v1/logins/{id}
  getLogin(id) { return this.#send('GET', `/v1/logins/${encodeURIComponent(id)}`); }

  // PATCH /v1/logins/{id}: {site?, username?, password?, name?}. A new password starts over.
  updateLogin(id, changes) { return this.#send('PATCH', `/v1/logins/${encodeURIComponent(id)}`, {body: changes}); }

  // DELETE /v1/logins/{id}: the login and its signed-in session.
  async deleteLogin(id) { await this.#send('DELETE', `/v1/logins/${encodeURIComponent(id)}`); }

  // POST /v1/browser-sessions: start a browser you drive yourself with Playwright
  // ({allow_hosts, ttl_s?, idle_ttl_s?, route?, secrets?, login?, viewport?, max_credits?}).
  // Connect with playwright.firefox.connect(session.ws_url, {headers: {Authorization: 'Bearer fxk_...'}})
  // and use browser.contexts()[0]. Sent with an idempotency_key, so a retry gets the same session.
  async createBrowserSession(input) {
    if (!isObject(input) || !Array.isArray(input.allow_hosts)) throw new FetchXError('allow_hosts_required');
    return this.#start('/v1/browser-sessions', input);
  }

  // GET /v1/browser-sessions/{id}: the session, or its receipt once it has ended.
  getBrowserSession(id) { return this.#send('GET', `/v1/browser-sessions/${encodeURIComponent(id)}`); }

  // GET /v1/browser-sessions: {items}, newest first; {status: 'open' | 'closed'}.
  listBrowserSessions({status} = {}) {
    return this.#send('GET', '/v1/browser-sessions' + (status ? `?status=${encodeURIComponent(status)}` : ''));
  }

  // DELETE /v1/browser-sessions/{id}: close it; resolves with its receipt.
  closeBrowserSession(id) { return this.#send('DELETE', `/v1/browser-sessions/${encodeURIComponent(id)}`); }

  // POST /v1/browser-sessions/{id}/fill: type a session secret ({secret: 'name'}) or the
  // saved login's username or password ({secret: 'login.password'}) into the field
  // `selector` matches, in the frame at frame_url. The value never reaches you.
  fillBrowserSession(id, input) { return this.#send('POST', `/v1/browser-sessions/${encodeURIComponent(id)}/fill`, {body: input}); }

  // GET /v1/usage: {period: 'day' | 'month'} or {since, until}, and key_id for one API key
  usage(query = {}) {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null));
    return this.#send('GET', '/v1/usage' + (params.size ? `?${params}` : ''));
  }
}
