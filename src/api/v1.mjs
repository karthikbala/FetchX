// The public API: seven endpoints, one version.
//   POST   /v1/fetch                  get a URL
//   GET    /v1/fetch                  list recent requests
//   GET    /v1/fetch/:id              one request's result (poll a pending one)
//   GET    /v1/fetch/:id/content      the raw body, as received
//   GET    /v1/fetch/:id/screenshot   the screenshot (JPEG)
//   DELETE /v1/fetch/:id              delete stored content now
//   GET    /v1/usage                  credits and usage
import {GatewayError} from '../policy.mjs';

export const API_SCOPES = Object.freeze({write: 'fetch:write', read: 'fetch:read', usage: 'usage:read'});

const MESSAGES = {
  invalid_request: 'A field is missing or wrong; error.details.field names it.',
  url_not_allowed: 'The URL must be public http or https and must not resolve to a private address.',
  unauthorized: 'A valid API key is required: Authorization: Bearer fxk_...',
  api_key_scope_forbidden: 'This API key is not allowed to call this endpoint.',
  insufficient_credits: 'The balance is below the cheapest step this request could take.',
  max_credits_too_low: 'max_credits is below the cheapest step; see error.details.min_credits.',
  payment_hold: 'Spending is paused while a payment issue is resolved.',
  not_found: 'No request with that id in this project.',
  idempotency_conflict: 'This idempotency_key was used before with a different request.',
  request_too_large: 'The request body is over 1 MB.',
  too_many_requests: 'The project has too many requests running; wait and retry.',
  unavailable: 'FetchX cannot take work right now; wait and retry.',
  pending: 'The request is still running.',
  content_expired: 'The stored content has expired or was deleted.',
  credit_account_unavailable: 'The project has no credit account.',
};
const STATUS = {invalid_request: 400, url_not_allowed: 400, unauthorized: 401, api_key_scope_forbidden: 403, insufficient_credits: 402,
  max_credits_too_low: 402, payment_hold: 402, not_found: 404, idempotency_conflict: 409, request_too_large: 413, too_many_requests: 429,
  pending: 409, content_expired: 410};

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
  const counts = (await service.store.pool.query(`SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
      count(*) FILTER (WHERE status = 'failed')::int AS failed FROM fetch_requests
    WHERE project = $1 AND created_at >= $2 AND created_at < $3`, [project, from, to])).rows[0];
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

// app.authenticate(req, scope) sets req.project and req.keyId.
export function registerApi(app, {service, ledger}) {
  const guard = scope => async req => app.authenticate(req, scope);
  app.post('/v1/fetch', {preHandler: guard(API_SCOPES.write)}, async (req, reply) => {
    const view = await service.submit(req.project, req.body, {keyId: req.keyId});
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
  app.delete('/v1/fetch/:id', {...idParams, preHandler: guard(API_SCOPES.read)}, async (req, reply) => {
    await service.remove(req.project, req.params.id);
    return reply.code(204).send();
  });
  app.get('/v1/usage', {preHandler: guard(API_SCOPES.usage)}, req => usageReport({service, ledger}, req.project, req.query ?? {}));
}
