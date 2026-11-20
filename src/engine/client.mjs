// The engine's private API, as the platform calls it (docs/engine-api.json,
// pinned from karthikbala/fetchx-engine). Every call carries the service
// token. Engine refusals come back as GatewayErrors with the engine's code,
// status and details; an engine that cannot be reached is `unavailable` (503),
// with `sent: false` when the connection was never made, so nothing can have
// started.
import {GatewayError} from '../policy.mjs';

export const ENGINE_CONTRACT = '1.2';
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function unavailable(sent, cause) {
  const error = new GatewayError('unavailable', 503);
  error.sent = sent;
  error.engineCause = cause;
  return error;
}

export class EngineClient {
  // settings: {url, serviceToken, timeoutMs?}. fetchImpl replaces the network in tests.
  constructor(settings = {}, {fetchImpl = globalThis.fetch} = {}) {
    this.url = typeof settings.url === 'string' ? settings.url.replace(/\/+$/, '') : null;
    this.token = settings.serviceToken;
    this.timeoutMs = settings.timeoutMs ?? 90_000;
    this.fetchImpl = fetchImpl;
  }

  get configured() { return !!this.url && typeof this.token === 'string' && this.token.length >= 32; }

  async #call(method, path, {query, body, headers = {}, raw = false, timeoutMs = this.timeoutMs} = {}) {
    if (!this.configured) throw unavailable(false, 'not_configured');
    const search = query ? new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)])).toString() : '';
    let response;
    try {
      response = await this.fetchImpl(`${this.url}${path}${search ? `?${search}` : ''}`, {method, redirect: 'error',
        headers: {authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : {'content-type': 'application/json'}), ...headers},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(timeoutMs)});
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      throw unavailable(!NOT_SENT.has(code), error?.name === 'TimeoutError' ? 'timeout' : code ?? 'network');
    }
    if (raw && response.ok) {
      return {status: response.status, body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream'};
    }
    const text = await response.text();
    if (response.status === 204) return {status: 204, body: null};
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (response.ok) {
      if (json === null) throw unavailable(true, 'bad_response');
      return {status: response.status, body: json};
    }
    const error = json?.error;
    if (response.status >= 400 && response.status < 500 && typeof error?.code === 'string') {
      // The token is the platform's own configuration, never the caller's fault.
      if (response.status === 401) throw unavailable(true, 'engine_unauthorized');
      const refusal = new GatewayError(error.code, response.status);
      if (error.details) refusal.details = error.details;
      refusal.fromEngine = true;
      throw refusal;
    }
    throw unavailable(true, `http_${response.status}`);
  }

  // {id, tenant, request, allowed_steps, wait_ms?} -> {status, envelope}
  async startJob(input) {
    const waitMs = input.wait_ms ?? 60_000;
    const {status, body} = await this.#call('POST', '/internal/v1/jobs', {body: input, timeoutMs: Math.max(this.timeoutMs, waitMs + 30_000)});
    return {status, envelope: body};
  }

  async getJob(tenant, id, {includeBody = true} = {}) {
    return (await this.#call('GET', `/internal/v1/jobs/${encodeURIComponent(id)}`,
      {query: {tenant, ...(includeBody ? {} : {include_body: 'false'})}})).body;
  }

  async listJobs(tenant, query = {}) {
    const {tenant: _ignored, ...rest} = query;
    return (await this.#call('GET', '/internal/v1/jobs', {query: {...rest, tenant}})).body;
  }

  async content(tenant, id, kind) {
    const {body, contentType} = await this.#call('GET', `/internal/v1/jobs/${encodeURIComponent(id)}/${kind}`, {query: {tenant}, raw: true});
    return {body, contentType};
  }

  async remove(tenant, id) {
    await this.#call('DELETE', `/internal/v1/jobs/${encodeURIComponent(id)}`, {query: {tenant}});
  }

  async status() {
    return (await this.#call('GET', '/internal/v1/status', {timeoutMs: 10_000})).body;
  }

  // The admin portal's back end. `path` is under /internal/v1/admin.
  async admin(method, path, {body, actor} = {}) {
    return (await this.#call(method, `/internal/v1/admin${path}`, {body, headers: actor ? {'x-fetchx-actor': actor} : {}})).body;
  }
}
