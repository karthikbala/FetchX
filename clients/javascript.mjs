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
  constructor(code, {status = null, details, retryAfterSeconds = null, idempotencyKey = null, response = null} = {}) {
    super(code);
    this.name = 'FetchXError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
    this.idempotencyKey = idempotencyKey;
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
    if (!isObject(data)) throw new FetchXError('invalid_response', {status: response.status, idempotencyKey});
    if (!response.ok) {
      const error = isObject(data.error) ? data.error : {};
      const retryAfter = Number(error.retry_after_seconds ?? response.headers.get('retry-after')) || null;
      throw new FetchXError(typeof error.code === 'string' ? error.code : 'request_failed',
        {status: response.status, details: error.details, retryAfterSeconds: retryAfter, idempotencyKey, response: data});
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

  // GET /v1/balance: {credits, reserved, trial, purchased, payment_hold}
  balance() { return this.#send('GET', '/v1/balance'); }

  // GET /v1/usage: {period: 'day' | 'month'} or {since, until}
  usage(query = {}) {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null));
    return this.#send('GET', '/v1/usage' + (params.size ? `?${params}` : ''));
  }
}
