// The POST /v1/fetch request: validation, defaults and the canonical form used
// for idempotency. Every refusal names the field it is about.
import {randomUUID} from 'node:crypto';
import {GatewayError, ID} from '../policy.mjs';
import {sha} from '../crypto.mjs';
import {checkUrl} from './destination.mjs';
import {checkHeaders} from './http-attempt.mjs';

export const FORMATS = Object.freeze(['markdown', 'text', 'links', 'metadata', 'json', 'screenshot']);
export const METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const ROUTE_CLASSES = Object.freeze(['direct', 'datacenter', 'residential']);
export const MAX_ATTEMPTS = 5;
export const LIMITS = Object.freeze({
  maxRequestBodyBytes: 1_000_000,
  maxWaitMs: 10_000,
  minTimeoutMs: 5_000,
  // Room for a page, a captcha solve (often 15-60 s) and the reload.
  maxTimeoutMs: 180_000,
  defaultTimeoutMs: 120_000,
  maxCredits: 100_000,
});
const FIELDS = ['url', 'method', 'headers', 'body', 'body_base64', 'render', 'formats', 'include_body', 'wait_for', 'country',
  'route', 'max_attempts', 'fix_headers', 'max_credits', 'timeout_ms', 'async', 'webhook_url', 'idempotency_key', 'tags'];
const COUNTRY = /^[A-Z]{2}$/;
const TAG = /^[A-Za-z0-9_.:-]{1,64}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(field, reason) {
  const error = new GatewayError('invalid_request', 400);
  error.details = {field, ...(reason ? {reason} : {})};
  return error;
}
const check = (condition, field, reason) => { if (!condition) throw invalid(field, reason); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
export const canonical = value => JSON.stringify(sort(value));

export function parseFetchRequest(raw, {blocked} = {}) {
  check(plain(raw), 'body', 'must be a JSON object');
  for (const key of Object.keys(raw)) check(FIELDS.includes(key), key, 'unknown field');
  check(typeof raw.url === 'string' && raw.url.length > 0, 'url', 'required');
  let url;
  try { url = checkUrl(raw.url, {blocked}); } catch (error) {
    if (error.code === 'url_not_allowed') {
      error.status = 400;
      error.details = {field: 'url'};
    }
    throw error;
  }

  const method = raw.method ?? 'GET';
  check(METHODS.includes(method), 'method', `one of ${METHODS.join(', ')}`);
  const readOnly = method === 'GET' || method === 'HEAD';

  let headers;
  try { headers = checkHeaders(raw.headers); } catch (error) { throw invalid('headers', error.details?.header); }

  check(raw.body === undefined || raw.body_base64 === undefined, 'body', 'send body or body_base64, not both');
  let body = null;
  if (raw.body !== undefined) {
    check(typeof raw.body === 'string', 'body', 'must be a string');
    body = Buffer.from(raw.body, 'utf8');
  } else if (raw.body_base64 !== undefined) {
    check(typeof raw.body_base64 === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.body_base64),
      'body_base64', 'must be base64');
    body = Buffer.from(raw.body_base64, 'base64');
  }
  if (body) {
    check(!readOnly, 'body', 'only with POST, PUT, PATCH or DELETE');
    if (body.length > LIMITS.maxRequestBodyBytes) {
      const error = new GatewayError('request_too_large', 413);
      error.details = {field: 'body', max_bytes: LIMITS.maxRequestBodyBytes};
      throw error;
    }
  }

  const render = raw.render ?? 'auto';
  check(['auto', 'always', 'never'].includes(render), 'render', 'auto, always or never');

  const formats = raw.formats ?? [];
  check(Array.isArray(formats) && formats.every(f => FORMATS.includes(f)) && new Set(formats).size === formats.length,
    'formats', `unique values from ${FORMATS.join(', ')}`);
  const includeBody = raw.include_body ?? true;
  check(typeof includeBody === 'boolean', 'include_body', 'boolean');

  let waitFor = null;
  if (raw.wait_for !== undefined) {
    check(plain(raw.wait_for) && Object.keys(raw.wait_for).every(k => ['selector', 'ms'].includes(k)), 'wait_for', '{selector?, ms?}');
    const {selector, ms} = raw.wait_for;
    check(selector === undefined || (typeof selector === 'string' && selector.length > 0 && selector.length <= 512),
      'wait_for.selector', 'a CSS selector up to 512 characters');
    check(ms === undefined || integer(ms, 0, LIMITS.maxWaitMs), 'wait_for.ms', `0 to ${LIMITS.maxWaitMs}`);
    check(selector !== undefined || ms !== undefined, 'wait_for', 'selector or ms');
    waitFor = {selector: selector ?? null, ms: ms ?? (selector ? LIMITS.maxWaitMs : 0)};
  }

  const country = raw.country ?? null;
  check(country === null || (typeof country === 'string' && COUNTRY.test(country)), 'country', 'ISO 3166-1 alpha-2, uppercase');

  let route = null;
  if (raw.route !== undefined) {
    check(plain(raw.route) && Object.keys(raw.route).every(k => ['class', 'country', 'render'].includes(k)), 'route', '{class, country, render?}');
    check(ROUTE_CLASSES.includes(raw.route.class), 'route.class', ROUTE_CLASSES.join(', '));
    const routeCountry = raw.route.country ?? null;
    if (raw.route.class === 'direct') check(routeCountry === null, 'route.country', 'null for direct');
    else check(typeof routeCountry === 'string' && COUNTRY.test(routeCountry), 'route.country', 'required for proxy routes');
    check(raw.route.render === undefined || typeof raw.route.render === 'boolean', 'route.render', 'boolean');
    route = {class: raw.route.class, country: routeCountry, render: raw.route.render ?? render === 'always'};
  }

  const maxAttempts = raw.max_attempts ?? MAX_ATTEMPTS;
  check(integer(maxAttempts, 1, MAX_ATTEMPTS), 'max_attempts', `1 to ${MAX_ATTEMPTS}`);
  const fix = raw.fix_headers ?? true;
  check(typeof fix === 'boolean', 'fix_headers', 'boolean');
  const maxCredits = raw.max_credits ?? null;
  check(maxCredits === null || integer(maxCredits, 1, LIMITS.maxCredits), 'max_credits', `1 to ${LIMITS.maxCredits}`);
  const timeoutMs = raw.timeout_ms ?? LIMITS.defaultTimeoutMs;
  check(integer(timeoutMs, LIMITS.minTimeoutMs, LIMITS.maxTimeoutMs), 'timeout_ms', `${LIMITS.minTimeoutMs} to ${LIMITS.maxTimeoutMs}`);
  const async = raw.async ?? false;
  check(typeof async === 'boolean', 'async', 'boolean');

  let webhookUrl = null;
  if (raw.webhook_url !== undefined) {
    let hook;
    try { hook = checkUrl(raw.webhook_url, {blocked}); } catch { throw invalid('webhook_url', 'a public https URL'); }
    check(hook.protocol === 'https:', 'webhook_url', 'a public https URL');
    webhookUrl = hook.href;
  }

  const tags = raw.tags ?? [];
  check(Array.isArray(tags) && tags.length <= 10 && tags.every(t => typeof t === 'string' && TAG.test(t)), 'tags',
    'up to 10 tags of 1 to 64 characters from A-Z a-z 0-9 _ . : -');

  const idempotencyKey = raw.idempotency_key ?? null;
  check(idempotencyKey === null || (typeof idempotencyKey === 'string' && ID.test(idempotencyKey)), 'idempotency_key',
    '1 to 160 characters from A-Z a-z 0-9 _ . : -');

  // Browser-only options need a method a browser can send.
  if (!readOnly || method === 'HEAD') {
    check(render !== 'always' && !route?.render, 'render', 'a browser can only send GET');
    check(!waitFor, 'wait_for', 'a browser can only send GET');
    check(!formats.includes('screenshot'), 'formats', 'screenshot needs a browser, which can only send GET');
  }
  check(!(render === 'never' && (waitFor || formats.includes('screenshot'))), 'render', 'wait_for and screenshot need a browser');

  const request = {
    url: url.href, method, headers, body_base64: body ? body.toString('base64') : null,
    render, formats: [...formats].sort(), include_body: includeBody, wait_for: waitFor, country, route,
    max_attempts: maxAttempts, fix_headers: fix, max_credits: maxCredits, timeout_ms: timeoutMs, async,
    webhook_url: webhookUrl, tags: [...tags].sort(),
  };
  return {
    request,
    idempotencyKey: idempotencyKey ?? `auto_${randomUUID()}`,
    generatedKey: idempotencyKey === null,
    // The body hash decides "same request": everything except the key itself.
    hash: sha(canonical(request)),
  };
}

// The browser is needed whatever the ladder learns.
export const needsBrowser = request => request.render === 'always' || !!request.wait_for
  || request.formats.includes('screenshot') || !!request.route?.render;
