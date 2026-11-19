// One browser attempt on one route, run by a Camoufox worker. The gateway keeps
// control of everything that leaves the browser: each request is admitted here
// (URL policy, method, provider rules, DNS pinning), and the relay only opens
// tunnels to pinned hosts through the route's proxy. CAPTCHA solutions are
// fetched here too, so the solver key never reaches the worker.
import {GatewayError, fail} from '../policy.mjs';
import {providerRule} from '../provider-rules.mjs';
import {checkAddresses, checkUrl} from './destination.mjs';
import {startRelay, TUNNEL_FAILURES} from '../browser/relay.mjs';

const PAGE_POST_MAX_BYTES = 64 * 1024;
const PAGE_POST_TYPES = new Set(['xhr', 'fetch']);
const LOCALES = {
  US: ['en-US', 'America/New_York'], GB: ['en-GB', 'Europe/London'], IN: ['en-IN', 'Asia/Kolkata'],
  DE: ['de-DE', 'Europe/Berlin'], FR: ['fr-FR', 'Europe/Paris'], CA: ['en-CA', 'America/Toronto'],
  AU: ['en-AU', 'Australia/Sydney'], AE: ['en-AE', 'Asia/Dubai'], SG: ['en-SG', 'Asia/Singapore'],
  JP: ['ja-JP', 'Asia/Tokyo'], ES: ['es-ES', 'Europe/Madrid'], IT: ['it-IT', 'Europe/Rome'],
  NL: ['nl-NL', 'Europe/Amsterdam'], BR: ['pt-BR', 'America/Sao_Paulo'], MX: ['es-MX', 'America/Mexico_City'],
};
// Headers a browser sets itself; the caller's copies would break its fingerprint.
const BROWSER_OWNED = new Set(['user-agent', 'accept', 'accept-language', 'accept-encoding', 'cookie']);

// The caller's Cookie header becomes cookies in the browser context.
function cookiesFrom(header, url) {
  if (!header) return [];
  return header.split(';').map(part => part.trim()).filter(Boolean).slice(0, 100).map(pair => {
    const index = pair.indexOf('=');
    return {name: pair.slice(0, index), value: pair.slice(index + 1), url: url.origin};
  }).filter(cookie => cookie.name);
}

// request: {url (URL), headers}
// context: {config, route, proxy, resolve, blocked, slots, runtime, solver, ids: {request, project}}
// options: {deadline, waitFor, screenshot, captcha, settleMs, limits}
export async function browserAttempt(request, context, options) {
  const {config, route, proxy, resolve, blocked, slots, runtime, solver, ids} = context;
  if (request.url.protocol !== 'https:') fail('browser_requires_https', 409);
  if (!runtime) fail('browser_unavailable', 503);
  const pins = new Map();
  const artifacts = {};
  let dispatched = false;
  let admitted = 0;
  // Every host the browser reaches is checked and pinned to one public address.
  const pinHost = async url => {
    if (Date.now() >= options.deadline) fail('browser_deadline', 504);
    if (++admitted > options.limits.max_requests) fail('browser_request_limit', 429);
    if (proxy && route.provider && providerRule(config, route.provider, url.hostname)) fail('provider_excluded');
    const host = url.hostname.toLowerCase();
    let pin = pins.get(host);
    if (!pin) {
      const addresses = checkAddresses(await resolve(new URL(`https://${host}`), {proxy}));
      pin = {destination: {url: new URL(`https://${host}`), address: addresses[0].address, family: addresses[0].family}, permits: 0};
      pins.set(host, pin);
    }
    pin.permits++;
    return pin;
  };
  // Requests the page makes (seen by the browser's request interception).
  const admit = async meta => {
    let url;
    try { url = checkUrl(meta?.url, {blocked}); } catch { fail('url_not_allowed'); }
    if (url.protocol !== 'https:') fail('insecure_request');
    const pagePost = meta.method === 'POST' && PAGE_POST_TYPES.has(meta.resource_type)
      && Number.isSafeInteger(meta.body_bytes) && meta.body_bytes <= PAGE_POST_MAX_BYTES;
    if (!['GET', 'HEAD'].includes(meta.method) && !pagePost) fail('method_refused');
    await pinHost(url);
    return {ok: true};
  };
  // Connections interception never saw, such as redirect hops: the relay asks
  // before tunnelling to a host that is not pinned yet.
  const admitHost = async host => {
    let url;
    try { url = checkUrl(`https://${host}/`, {blocked}); } catch { fail('url_not_allowed'); }
    return pinHost(url);
  };
  const artifact = async data => {
    if (!data || !['dom', 'document', 'screenshot'].includes(data.kind) || typeof data.body_base64 !== 'string') {
      fail('browser_artifact_invalid', 400);
    }
    const body = Buffer.from(data.body_base64, 'base64');
    const cap = data.kind === 'screenshot' ? 2_000_000 : data.kind === 'dom' ? options.limits.max_dom_bytes : options.limits.max_body_bytes;
    if (body.length > cap) fail('too_large', 400);
    artifacts[data.kind] = {body, content_type: typeof data.content_type === 'string' ? data.content_type.slice(0, 200) : null};
    return {ok: true};
  };
  const captcha = async (data, {signal} = {}) => {
    if (!options.captcha || !solver) fail('captcha_not_enabled', 403);
    let page;
    try { page = new URL(data?.website_url); } catch { fail('captcha_request_invalid', 400); }
    if (!pins.has(page.hostname.toLowerCase())) fail('captcha_request_invalid', 400);
    const common = {request: ids.request, project: ids.project, websiteURL: page.href, userAgent: data.user_agent};
    if (data.type === 'datadome') {
      if (!proxy) fail('captcha_requires_proxy', 409);
      const answer = await solver.solve('datadome', {...common, captchaUrl: data.captcha_url, proxyUrl: proxy.url}, {signal});
      return {ok: true, cookie: answer.cookie};
    }
    if (data.type === 'grid') {
      const answer = await solver.solve('grid', {...common, image: data.image, instructions: data.instructions,
        rows: data.rows, columns: data.columns}, {signal});
      return {ok: true, click: answer.click};
    }
    if (['turnstile', 'recaptcha_v2'].includes(data.type)) {
      const answer = await solver.solve(data.type, {...common, siteKey: data.site_key, invisible: data.invisible === true}, {signal});
      return {ok: true, token: answer.token};
    }
    fail('captcha_unsupported', 400);
  };

  const relay = await startRelay({pins, admitHost, proxy, maxBytes: options.limits.max_wire_bytes, deadline: options.deadline,
    onConnect: async () => { dispatched = true; }});
  const slot = await slots.acquire(runtime, {deadline: options.deadline}).catch(async error => {
    await relay.close();
    throw error;
  });
  const [locale, timezone] = LOCALES[route.country] ?? LOCALES.US;
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([name]) => !BROWSER_OWNED.has(name)));
  let output;
  try {
    output = await slot.run({
      url: request.url.href,
      deadline: options.deadline,
      runtime,
      relay: relay.url,
      limits: {max_requests: options.limits.max_requests, max_dom_bytes: options.limits.max_dom_bytes,
        max_body_bytes: options.limits.max_body_bytes},
      settle_ms: options.settleMs,
      wait_for: options.waitFor,
      screenshot: options.screenshot,
      captcha: !!options.captcha && !!solver,
      headers,
      cookies: cookiesFrom(request.headers?.cookie, request.url),
      locale,
      timezone,
    }, {admit, artifact, captcha});
  } finally {
    slot.release();
    await relay.close();
  }
  const wireBytes = relay.bytes;
  if (!output || output.status === null || output.status === undefined) {
    const code = relay.error === 'too_large' || TUNNEL_FAILURES.has(relay.error) ? relay.error
      : output?.error && /^browser_/.test(output.error) ? output.error : 'browser_failed';
    const error = new GatewayError(code, 502);
    error.dispatched = dispatched;
    error.wire_bytes = wireBytes;
    error.captcha = output?.captcha ?? [];
    throw error;
  }
  const document = artifacts.dom ?? artifacts.document ?? null;
  return {
    status: output.status,
    final_url: output.final_url,
    headers: {...(output.headers ?? {}), ...(artifacts.dom ? {'content-type': 'text/html; charset=utf-8'} : {})},
    body: document?.body ?? Buffer.alloc(0),
    screenshot: artifacts.screenshot?.body ?? null,
    cookies: output.cookies ?? [],
    wire_bytes: wireBytes,
    dispatched,
    captcha: output.captcha ?? [],
    wait_for: output.wait_for ?? null,
    requests: output.requests ?? 0,
    blocked: output.blocked ?? 0,
    error: output.error ?? null,
  };
}
