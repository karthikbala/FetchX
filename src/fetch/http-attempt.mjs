// One HTTP attempt on one route: resolve and pin the destination, send the
// request, follow redirects (each re-checked), decode the body. Cookies the site
// sets are kept for the redirects of this attempt and returned to the caller.
import {CookieJar} from 'tough-cookie';
import {GatewayError, fail} from '../policy.mjs';
import {checkAddresses, checkRedirect} from './destination.mjs';
import {exchange, decodeBody} from './transport.mjs';

export const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Headers that describe the connection, the proxy or the caller's own network.
// FetchX sets these itself or drops them.
const REFUSED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'keep-alive', 'proxy-authorization', 'proxy-connection', 'forwarded', 'via']);
// Dropped when a redirect leaves the caller's original origin.
const ORIGIN_BOUND_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'api-key']);
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const AUTOMATION_UA = /^$|curl|wget|python|aiohttp|httpx|requests|urllib|scrapy|go-http|golang|java\/|okhttp|apache-httpclient|axios|node-fetch|undici|got \(|libwww|postman|insomnia|headless|phantomjs|selenium|puppeteer|playwright|\bbot\b|crawler|spider/i;

export function checkHeaders(headers) {
  if (headers === undefined) return {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) fail('invalid_request');
  const out = {};
  let bytes = 0;
  const entries = Object.entries(headers);
  if (entries.length > 64) fail('invalid_request');
  for (const [key, value] of entries) {
    const name = key.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name) || typeof value !== 'string'
      || /[\u0000-\u0008\u000a-\u001f\u007fĀ-￿]/.test(value)) {
      const error = new GatewayError('invalid_request');
      error.details = {field: 'headers', header: name.slice(0, 80)};
      throw error;
    }
    if (REFUSED_HEADERS.has(name) || name.startsWith('x-forwarded-') || name.startsWith('x-fetchx')) {
      const error = new GatewayError('invalid_request');
      error.details = {field: 'headers', header: name};
      throw error;
    }
    bytes += name.length + Buffer.byteLength(value);
    if (bytes > 16384) fail('invalid_request');
    out[name] = value;
  }
  return out;
}

// Replaces an automation User-Agent and adds the headers every browser sends.
// Returns the names it changed, reported to the caller as `fixes`.
export function fixHeaders(headers) {
  const out = {...headers};
  const fixed = [];
  if (AUTOMATION_UA.test((out['user-agent'] ?? '').trim())) {
    out['user-agent'] = BROWSER_USER_AGENT;
    fixed.push('user-agent');
  }
  if (!out.accept) {
    out.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    fixed.push('accept');
  }
  if (!out['accept-language']) {
    out['accept-language'] = 'en-US,en;q=0.9';
    fixed.push('accept-language');
  }
  return {headers: out, fixed};
}

// request: {url (URL), method, headers, body}
// route:   {proxy, resolve(url, {proxy})}
// limits:  {deadline, maxBodyBytes, maxWireBytes}
export async function httpAttempt(request, {proxy, resolve, blocked, pace = async () => {}}, limits,
  {exchangeImpl = exchange} = {}) {
  const jar = new CookieJar();
  const originalOrigin = request.url.origin;
  let current = {url: request.url, method: request.method, body: request.body ?? null};
  let wireBytes = 0;
  let dispatched = false;
  const remainingMs = () => limits.deadline - Date.now();
  try {
    for (let hop = 0; ; hop++) {
      if (remainingMs() <= 0) fail('source_timeout', 504);
      // Checked here as well as in the resolver, so no resolver can bypass it.
      const addresses = checkAddresses(await resolve(current.url, {proxy}));
      const destination = {url: current.url, address: addresses[0].address, family: addresses[0].family};
      const headers = {'accept-encoding': 'gzip, br, deflate', ...request.headers};
      if (current.url.origin !== originalOrigin) for (const name of ORIGIN_BOUND_HEADERS) delete headers[name];
      const jarCookies = await jar.getCookieString(current.url.href);
      if (jarCookies) headers.cookie = headers.cookie ? `${headers.cookie}; ${jarCookies}` : jarCookies;
      await pace(current.url);
      let response;
      try {
        response = await exchangeImpl({method: current.method, headers, body: current.body}, destination, {
          timeoutMs: Math.max(1, remainingMs()),
          maxBodyBytes: limits.maxBodyBytes,
          maxWireBytes: Math.max(1, limits.maxWireBytes - wireBytes),
        }, {proxy});
      } catch (error) {
        if (error.dispatched !== false) dispatched = true;
        if (Number.isSafeInteger(error.wire_bytes)) wireBytes += error.wire_bytes;
        throw error;
      }
      dispatched = true;
      wireBytes = Number.isSafeInteger(response.wire_bytes) ? wireBytes + response.wire_bytes : wireBytes;
      for (const cookie of [].concat(response.headers['set-cookie'] ?? [])) {
        await jar.setCookie(cookie, current.url.href, {ignoreError: true});
      }
      const location = response.headers.location;
      if (REDIRECTS.has(response.status) && location && hop < MAX_REDIRECTS) {
        const target = checkRedirect(location, current.url, {blocked});
        // 303, and 301/302 after POST, become GET as browsers do.
        const toGet = response.status === 303 || ([301, 302].includes(response.status) && current.method === 'POST');
        current = {url: target, method: toGet ? 'GET' : current.method, body: toGet ? null : current.body};
        continue;
      }
      if (REDIRECTS.has(response.status) && location) fail('too_many_redirects', 502);
      const body = current.method === 'HEAD' || [204, 205, 304].includes(response.status)
        ? Buffer.alloc(0)
        : decodeBody(response.encoded, response.headers['content-encoding'], {maxDecodedBytes: limits.maxBodyBytes});
      return {
        status: response.status,
        final_url: current.url.href,
        headers: response.headers,
        body,
        wire_bytes: wireBytes,
        cookies: (await jar.getCookies(current.url.href)).map(cookie => ({
          name: cookie.key, value: cookie.value, domain: cookie.domain ?? current.url.hostname, path: cookie.path ?? '/',
          ...(cookie.expires instanceof Date ? {expires: cookie.expires.toISOString()} : {}),
        })),
        redirects: hop,
        dispatched,
      };
    }
  } catch (error) {
    if (error instanceof GatewayError) {
      // True once any hop of this attempt may have reached the site.
      error.dispatched = dispatched;
      error.wire_bytes = wireBytes;
    }
    throw error;
  }
}
