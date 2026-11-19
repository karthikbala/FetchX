// One page capture in a fresh browser context. Engine-neutral: it uses only the
// Playwright API, so production runs it in Camoufox and tests can run it in any
// Playwright browser. Every request the page makes is first admitted by the
// gateway (hooks.admit: URL policy, DNS pinning, provider rules, request cap);
// a refused request is aborted before it leaves the browser. Large outputs go
// to the gateway through hooks.artifact; the returned summary stays small.
import {solvePageCaptchas} from './page-captcha.mjs';

export const SCREENSHOT_MAX_BYTES = 2_000_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

const remainingMs = input => Math.max(1, input.deadline - Date.now());
const safeCode = error => {
  const message = String(error?.message ?? '');
  return /net::(ERR_[A-Z_]+)/.exec(message)?.[1] ?? /\b(NS_ERROR_[A-Z_]+)\b/.exec(message)?.[1]
    ?? (error?.name === 'TimeoutError' ? 'TIMEOUT' : 'CAPTURE_ERROR');
};
const sameOrigin = (a, b) => {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
};

// Adds the caller's cookies to a request's Cookie header, keeping any the page already has.
function mergeCookies(existing, cookies) {
  const pairs = new Map((existing ?? '').split(';').map(part => part.trim()).filter(Boolean)
    .map(pair => [pair.split('=', 1)[0], pair]));
  for (const cookie of cookies) if (!pairs.has(cookie.name)) pairs.set(cookie.name, `${cookie.name}=${cookie.value}`);
  return [...pairs.values()].join('; ');
}

// A Set-Cookie header as {name, value, domain, path, expires?}, for engines whose
// cookie jar the automation API cannot read.
function parseSetCookie({value, url}) {
  const [pair, ...attributes] = String(value).split(';').map(part => part.trim());
  const index = pair.indexOf('=');
  if (index < 1) return null;
  const cookie = {name: pair.slice(0, index), value: pair.slice(index + 1), domain: new URL(url).hostname, path: '/'};
  for (const attribute of attributes) {
    const [key, ...rest] = attribute.split('=');
    const name = key.toLowerCase(), raw = rest.join('=');
    if (name === 'domain' && raw) cookie.domain = raw.replace(/^\./, '');
    else if (name === 'path' && raw.startsWith('/')) cookie.path = raw;
    else if (name === 'expires' && Number.isFinite(Date.parse(raw))) cookie.expires = new Date(raw).toISOString();
  }
  return cookie;
}

// input: {url, deadline, headers, cookies, wait_for, settle_ms, screenshot, captcha,
//         limits: {max_requests, max_dom_bytes, max_body_bytes}, locale, timezone}
export async function capturePage(browser, input, hooks) {
  const result = {status: null, final_url: null, headers: null, requests: 0, blocked: 0, blocked_reasons: {},
    dom_bytes: 0, body_bytes: 0, screenshot_bytes: 0, captcha: [], wait_for: null, cookies: [], error: null};
  let context;
  let page;
  let mainDocument = null;
  const setCookies = [];
  const block = reason => {
    result.blocked++;
    result.blocked_reasons[reason] = (result.blocked_reasons[reason] ?? 0) + 1;
  };
  try {
    context = await browser.newContext({
      serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false,
      locale: input.locale ?? 'en-US', timezoneId: input.timezone ?? 'America/New_York',
      viewport: {width: 1366, height: 768},
    });
    if (input.cookies?.length) await context.addCookies(input.cookies).catch(() => {});
    await context.routeWebSocket?.('**/*', ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request();
      let frame = 'child';
      try { frame = request.frame() === page?.mainFrame() ? 'main' : 'child'; } catch { /* no frame (worker) */ }
      const meta = {
        url: request.url(), method: request.method(), resource_type: request.resourceType(), frame,
        navigation: request.isNavigationRequest(), body_bytes: request.postDataBuffer()?.length ?? 0,
        redirected_from: request.redirectedFrom()?.url() ?? null,
      };
      if (result.requests >= input.limits.max_requests) {
        block('request_limit');
        return route.abort('blockedbyclient').catch(() => {});
      }
      try {
        await hooks.admit(meta);
      } catch (error) {
        block(/^[a-z_]{1,60}$/.test(error?.code ?? '') ? error.code : 'refused');
        return route.abort('blockedbyclient').catch(() => {});
      }
      result.requests++;
      // The caller's own headers and cookies go only to the page's origin. The
      // cookies are also sent as a header, because Camoufox's private browsing
      // jar ignores the automation cookie API.
      const own = sameOrigin(meta.url, input.url);
      const extra = own ? {...(input.headers ?? {})} : {};
      if (own && input.cookies?.length) extra.cookie = mergeCookies(request.headers().cookie, input.cookies);
      if (Object.keys(extra).length) await route.continue({headers: {...request.headers(), ...extra}}).catch(() => {});
      else await route.continue().catch(() => {});
    });
    page = await context.newPage();
    page.on('response', response => {
      try {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          mainDocument = {status: response.status(), url: response.url(), headers: response.headers(), response};
        }
        if (sameOrigin(response.url(), input.url)) {
          void response.headersArray().then(headers => {
            for (const {name, value} of headers) if (name.toLowerCase() === 'set-cookie') setCookies.push({value, url: response.url()});
          }).catch(() => {});
        }
      } catch { /* closed */ }
    });
    try {
      // The browser follows redirects itself; a hop to a new host is checked by
      // the relay before it is tunnelled (see relay.mjs admitHost).
      await page.goto(input.url, {waitUntil: 'domcontentloaded', timeout: Math.min(NAVIGATION_TIMEOUT_MS, remainingMs(input))});
    } catch (error) {
      result.error = safeCode(error);
    }
    if (!page.isClosed() && input.settle_ms) await page.waitForTimeout(Math.min(input.settle_ms, remainingMs(input)));
    if (input.captcha && hooks.captcha && !page.isClosed()) {
      result.captcha = await solvePageCaptchas(page, context, hooks, {deadline: input.deadline, settleMs: input.settle_ms ?? 0});
      if (result.captcha.some(solve => solve.outcome === 'passed')) result.error = null;
    }
    if (input.wait_for && !page.isClosed()) {
      const timeout = Math.min(input.wait_for.ms, remainingMs(input));
      if (input.wait_for.selector) {
        result.wait_for = await page.waitForSelector(input.wait_for.selector, {state: 'attached', timeout})
          .then(() => 'matched', () => 'timeout');
      } else {
        await page.waitForTimeout(timeout);
        result.wait_for = 'waited';
      }
    }
    if (mainDocument) {
      Object.assign(result, {status: mainDocument.status, final_url: page.url(), headers: mainDocument.headers});
      const contentType = mainDocument.headers['content-type'] ?? '';
      // Non-HTML documents (JSON, text, PDF) are captured as received.
      if (!/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
        const body = await mainDocument.response.body().catch(() => null);
        if (body && body.length <= input.limits.max_body_bytes) {
          await hooks.artifact({kind: 'document', content_type: contentType, body_base64: body.toString('base64')});
          result.body_bytes = body.length;
        } else if (body) result.error ??= 'too_large';
      } else if (!page.isClosed()) {
        const dom = Buffer.from(await page.content());
        if (dom.length > input.limits.max_dom_bytes) result.error ??= 'too_large';
        else {
          await hooks.artifact({kind: 'dom', content_type: 'text/html; charset=utf-8', body_base64: dom.toString('base64')});
          result.dom_bytes = dom.length;
        }
      }
      if (input.screenshot && !page.isClosed()) {
        try {
          const image = await page.screenshot({type: 'jpeg', quality: 75, timeout: Math.min(10_000, remainingMs(input))});
          if (image.length <= SCREENSHOT_MAX_BYTES) {
            await hooks.artifact({kind: 'screenshot', content_type: 'image/jpeg', body_base64: image.toString('base64')});
            result.screenshot_bytes = image.length;
          }
        } catch { /* a missing screenshot does not fail the capture */ }
      }
      const jar = await context.cookies(page.url()).catch(() => []);
      result.cookies = (jar.length ? jar.map(cookie => ({
        name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
        ...(cookie.expires > 0 ? {expires: new Date(cookie.expires * 1000).toISOString()} : {}),
      })) : setCookies.map(parseSetCookie).filter(Boolean)).slice(0, 100);
    }
    return result;
  } catch (error) {
    result.error ??= safeCode(error);
    return result;
  } finally {
    await context?.close().catch(() => {});
  }
}
