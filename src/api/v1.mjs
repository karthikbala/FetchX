// The public API, one version. `service` is the FetchFront
// (src/fetch/front.mjs): it bills, and the engine does the fetching.
// `estimator` prices requests before they are sent (src/fetch/estimate.mjs);
// `board` is the service status (src/status.mjs). Retired and unknown routes,
// deprecation headers and maintenance are src/api/lifecycle.mjs.
// `batches` is the BatchService (src/fetch/batches.mjs).
//   POST   /v1/fetch                  get a URL
//   POST   /v1/fetch/:id/next         get the page after request :id's (a new request)
//   GET    /v1/fetch                  list recent requests
//   GET    /v1/fetch/:id              one request's result (poll a pending one)
//   GET    /v1/fetch/:id/content      the raw body, as received
//   GET    /v1/fetch/:id/screenshot   the screenshot (JPEG)
//   GET    /v1/fetch/:id/network      the calls a request made with `capture` recorded (filters, contains search)
//   GET    /v1/fetch/:id/network/:index  one recorded call in full
//   GET    /v1/fetch/:id/network/:index/body  one recorded call's response body
//   GET    /v1/fetch/:id/network.har  the recorded calls as HAR 1.2
//   DELETE /v1/fetch/:id              delete stored content now
//   POST   /v1/batches                many URLs in one job, paced per site
//   GET    /v1/batches                list recent batches
//   GET    /v1/batches/:id            one batch: status, item counts, credits
//   GET    /v1/batches/:id/items      its items and their results, paged
//   POST   /v1/batches/:id/cancel     stop a batch (queued items are canceled)
//   POST   /v1/estimate               what a request or a batch would cost and take, before sending it
//   GET    /v1/balance                credits available now
//   GET    /v1/usage                  credits and usage
//   GET    /v1/logins                 the project's saved site logins (never their passwords)
//   POST   /v1/logins                 save a site login: FetchX signs in with it when a page asks
//   GET    /v1/logins/:id             one saved login
//   PATCH  /v1/logins/:id             change its site, username, password or name (a new password starts over)
//   DELETE /v1/logins/:id             delete it and its signed-in session
//   GET    /v1/me                     the project and key making the call (any valid key)
//   GET    /v1/status                 service status and notices (no API key)
//   GET    /v1/prices                 the price table and the trial (no API key)
import {GatewayError} from '../policy.mjs';
import {FEATURES} from './version.mjs';

export const API_SCOPES = Object.freeze({write: 'fetch:write', read: 'fetch:read', usage: 'usage:read'});
// A route any valid key may call, whatever its scopes (x-scope "any" in the contract).
export const ANY_SCOPE = 'any';
// What a 503 unavailable tells the caller to wait when nothing says otherwise.
export const UNAVAILABLE_RETRY_SECONDS = 30;

const MESSAGES = {
  invalid_request: 'A field is missing or wrong; error.details.field names it.',
  url_not_allowed: 'The URL must be public http or https and must not resolve to a private address.',
  unauthorized: 'A valid API key is required: Authorization: Bearer fxk_...',
  api_key_scope_forbidden: 'This API key is not allowed to call this endpoint.',
  api_key_expired: 'This API key has expired (error.details.expired_at). Change its expiry or make a new key in the console.',
  key_limit_reached: 'This API key has used its credit limit (error.details.limit: credits_per_day or credits_per_month) until error.details.resets_at. Nothing was sent or charged.',
  insufficient_credits: 'The balance is below the cheapest step this request could take.',
  max_credits_too_low: 'max_credits is below the cheapest step; see error.details.min_credits.',
  payment_hold: 'Spending is paused while a payment issue is resolved.',
  not_found: 'Nothing with that id in this project.',
  idempotency_conflict: 'This idempotency_key was used before with a different request.',
  request_too_large: 'The request body is over 1 MB.',
  too_many_requests: 'The project has too many requests running or queued; wait and retry.',
  unavailable: 'FetchX cannot take work right now; wait and retry.',
  pending: 'The request is still running.',
  content_expired: 'The stored content has expired or was deleted.',
  capture_not_found: 'That request was made without capture, so it has no network calls to read.',
  no_next_page: 'That request has no next page to open; error.details.reason says why.',
  credit_account_unavailable: 'The project has no credit account.',
  extract_unavailable: 'FetchX cannot read pages into JSON right now, so nothing was fetched or charged. Retry after retry_after_seconds, or send the request without extract.',
  maintenance: 'FetchX is paused for maintenance; nothing was sent or charged. Retry after Retry-After seconds; error.details.status_url says more.',
  route_retired: 'This route was retired; error.details.replacement says what to use instead.',
  route_not_found: 'There is no such route. Check the method and path against the docs (error.details.docs_url).',
  login_exists: 'This project already has a login for that username on that site; error.details.id names it.',
  login_limit: 'This project has as many saved logins as it may (error.details.max).',
  not_stored: 'The request was made with store: false (or secrets), so its content was given once and not kept.',
  secret_not_allowed_here: 'Secrets cannot be sent with this option; error.details.field names it.',
};
const STATUS = {invalid_request: 400, url_not_allowed: 400, unauthorized: 401, api_key_expired: 401, key_limit_reached: 402,
  api_key_scope_forbidden: 403, insufficient_credits: 402,
  max_credits_too_low: 402, payment_hold: 402, not_found: 404, idempotency_conflict: 409, request_too_large: 413, too_many_requests: 429,
  pending: 409, content_expired: 410, capture_not_found: 404, no_next_page: 409, route_retired: 410, route_not_found: 404, maintenance: 503,
  login_exists: 409, login_limit: 409, not_stored: 410, secret_not_allowed_here: 400};

export function apiError(error) {
  const known = error instanceof GatewayError;
  const code = known && /^[a-z][a-z0-9_]{1,80}$/.test(error.code) ? error.code
    : error?.validation || error?.statusCode === 400 ? 'invalid_request'
      : error?.statusCode === 413 ? 'request_too_large' : 'internal_error';
  const status = STATUS[code] ?? (known ? error.status : error?.statusCode >= 400 && error?.statusCode < 500 ? error.statusCode : 500);
  return {status: status >= 500 && code !== 'internal_error' ? 503 : status, body: {error: {
    code: status >= 500 && !known ? 'internal_error' : code,
    message: MESSAGES[code] ?? (status >= 500 ? 'FetchX had an internal problem; nothing was charged.' : 'The request was refused.'),
    ...(known && error.details ? {details: error.details} : {}),
    ...(known && error.details?.retry_after_seconds ? {retry_after_seconds: error.details.retry_after_seconds} : {}),
  }}};
}

function usagePeriod(query) {
  const now = new Date();
  if (query.since !== undefined || query.until !== undefined) {
    const from = new Date(query.since ?? '');
    const to = query.until === undefined ? now : new Date(query.until);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to - from > 92 * 86400_000) {
      throw Object.assign(new GatewayError('invalid_request'), {details: {field: 'since', reason: 'a range of up to 92 days'}});
    }
    return {from, to};
  }
  const period = query.period ?? 'month';
  if (!['day', 'month'].includes(period)) throw Object.assign(new GatewayError('invalid_request'), {details: {field: 'period'}});
  const from = period === 'day' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = period === 'day' ? new Date(from.getTime() + 86400_000) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {from, to};
}

export async function usageReport({service, ledger}, project, query = {}) {
  const {from, to} = usagePeriod(query);
  const counts = await service.counts(project, {from, to});
  const balance = await ledger.balance(project);
  const used = ledger.metered(project) ? await ledger.usage(project, {from, to}) : {credits: 0, by_step: [], captcha_solved: 0, daily: []};
  return {
    balance: balance ? {credits: balance.available, trial: balance.trial, purchased: balance.purchased, reserved: balance.reserved,
      payment_hold: balance.held} : null,
    period: {from: from.toISOString(), to: to.toISOString()},
    used: {credits: used.credits, succeeded: counts.succeeded, failed: counts.failed, captcha_solved: used.captcha_solved},
    by_step: used.by_step,
    daily: used.daily,
  };
}

const idParams = {schema: {params: {type: 'object', required: ['id'], properties: {id: {type: 'string', maxLength: 64}}}}};

// app.authenticate(req, scope) sets req.project, req.keyId and req.key ({id, name, prefix, scopes}).
export function registerApi(app, {service, ledger, estimator, board, batches, feedback}) {
  const guard = scope => async req => app.authenticate(req, scope);
  app.post('/v1/fetch', {preHandler: guard(API_SCOPES.write)}, async (req, reply) => {
    const view = await service.submit(req.project, req.body, {keyId: req.keyId});
    return reply.code(view.status === 'pending' ? 202 : 200).send(view);
  });
  app.post('/v1/fetch/:id/next', {...idParams, preHandler: guard(API_SCOPES.write)}, async (req, reply) => {
    const view = await service.submitNext(req.project, req.params.id, req.body ?? {}, {keyId: req.keyId});
    return reply.code(view.status === 'pending' ? 202 : 200).send(view);
  });
  app.get('/v1/fetch', {preHandler: guard(API_SCOPES.read)}, req => service.list(req.project, req.query ?? {}));
  app.get('/v1/fetch/:id', {...idParams, preHandler: guard(API_SCOPES.read)}, async (req, reply) => {
    const includeBody = req.query?.include_body !== 'false';
    const view = await service.get(req.project, req.params.id, {includeBody});
    return reply.code(view.status === 'pending' ? 202 : 200).send(view);
  });
  for (const kind of ['content', 'screenshot']) {
    app.get(`/v1/fetch/:id/${kind}`, {...idParams, preHandler: guard(API_SCOPES.read)}, async (req, reply) => {
      const {body, contentType} = await service.content(req.project, req.params.id, kind === 'content' ? 'body' : 'screenshot');
      return reply.header('content-type', contentType).header('cache-control', 'private, no-store').send(body);
    });
  }
  // A request's network capture (FetchFront passes these to the engine).
  const callParams = {schema: {params: {type: 'object', required: ['id', 'index'],
    properties: {id: {type: 'string', maxLength: 64}, index: {type: 'string', maxLength: 16}}}}};
  app.get('/v1/fetch/:id/network', {...idParams, preHandler: guard(API_SCOPES.read)},
    req => service.networkList(req.project, req.params.id, req.query ?? {}));
  app.get('/v1/fetch/:id/network.har', {...idParams, preHandler: guard(API_SCOPES.read)}, async (req, reply) => {
    const har = await service.networkHar(req.project, req.params.id, req.query ?? {});
    return reply.header('content-type', 'application/json').header('cache-control', 'private, no-store')
      .header('content-disposition', `attachment; filename="fetchx-${req.params.id}.har"`).send(har);
  });
  app.get('/v1/fetch/:id/network/:index', {...callParams, preHandler: guard(API_SCOPES.read)},
    req => service.networkCall(req.project, req.params.id, req.params.index, req.query ?? {}));
  app.get('/v1/fetch/:id/network/:index/body', {...callParams, preHandler: guard(API_SCOPES.read)}, async (req, reply) => {
    const {body, contentType} = await service.networkBody(req.project, req.params.id, req.params.index);
    return reply.header('content-type', contentType).header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff').send(body);
  });
  app.delete('/v1/fetch/:id', {...idParams, preHandler: guard(API_SCOPES.read)}, async (req, reply) => {
    await service.remove(req.project, req.params.id);
    return reply.code(204).send();
  });
  app.post('/v1/estimate', {preHandler: guard(API_SCOPES.write)}, req => estimator.estimate(req.project, req.body));
  app.post('/v1/batches', {preHandler: guard(API_SCOPES.write)}, async (req, reply) => {
    const {batch, created} = await batches.submit(req.project, req.body, {keyId: req.keyId});
    return reply.code(created ? 202 : 200).send(batch);
  });
  app.get('/v1/batches', {preHandler: guard(API_SCOPES.read)}, req => batches.list(req.project, req.query ?? {}));
  app.get('/v1/batches/:id', {...idParams, preHandler: guard(API_SCOPES.read)}, req => batches.get(req.project, req.params.id));
  app.get('/v1/batches/:id/items', {...idParams, preHandler: guard(API_SCOPES.read)},
    req => batches.items(req.project, req.params.id, req.query ?? {}));
  app.post('/v1/batches/:id/cancel', {...idParams, preHandler: guard(API_SCOPES.write)}, req => batches.cancel(req.project, req.params.id));
  // Tell FetchX how it handled a page, e.g. blocked through FetchX but fine from your own connection. Free.
  app.post('/v1/feedback', {preHandler: guard(API_SCOPES.write)}, async (req, reply) => {
    const {feedback: report, created} = await feedback.submit(req.project, req.body, {keyId: req.keyId});
    return reply.code(created ? 201 : 200).send(report);
  });
  app.get('/v1/feedback/:id', {...idParams, preHandler: guard(API_SCOPES.read)}, req => feedback.get(req.project, req.params.id));
  // Saved site logins (FetchFront passes these to the engine, which keeps them sealed). Free.
  app.get('/v1/logins', {preHandler: guard(API_SCOPES.read)}, req => service.listLogins(req.project));
  app.post('/v1/logins', {preHandler: guard(API_SCOPES.write)}, async (req, reply) => reply.code(201).send(await service.saveLogin(req.project, req.body)));
  app.get('/v1/logins/:id', {...idParams, preHandler: guard(API_SCOPES.read)}, req => service.getLogin(req.project, req.params.id));
  app.patch('/v1/logins/:id', {...idParams, preHandler: guard(API_SCOPES.write)}, req => service.updateLogin(req.project, req.params.id, req.body));
  app.delete('/v1/logins/:id', {...idParams, preHandler: guard(API_SCOPES.write)}, async (req, reply) => {
    await service.removeLogin(req.project, req.params.id);
    return reply.code(204).send();
  });
  app.get('/v1/balance', {preHandler: guard(API_SCOPES.usage)}, req => service.balance(req.project));
  app.get('/v1/usage', {preHandler: guard(API_SCOPES.usage)}, req => usageReport({service, ledger}, req.project, req.query ?? {}));
  // Who is calling: the project (the same after a key is rotated) and this key.
  // Also the project's concurrency limit and what this server supports.
  app.get('/v1/me', {preHandler: guard(ANY_SCOPE)}, async req => ({project_id: req.project, key_id: req.key?.id ?? req.keyId ?? null,
    key_name: req.key?.name ?? null, key_prefix: req.key?.prefix ?? null, scopes: req.key?.scopes ?? Object.values(API_SCOPES),
    limits: await service.keyLimits(req.key?.id ?? req.keyId ?? null), concurrency: await service.concurrency(req.project),
    features: [...FEATURES]}));
  // Public: no API key, any origin, and it answers during maintenance.
  app.get('/v1/status', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');
    return board.publicView();
  });
  // Public: no API key, any origin. What each step costs, and the trial a new account gets.
  app.get('/v1/prices', async (req, reply) => {
    reply.header('access-control-allow-origin', '*').header('cache-control', 'public, max-age=300');
    return ledger.publicPrices();
  });
}
