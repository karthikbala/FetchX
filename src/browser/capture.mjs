// One page capture in a fresh browser context. Engine-neutral: it uses only the
// Playwright API, so production runs it in Camoufox and tests can run it in any
// Playwright browser. Every request the page makes is first admitted by the
// gateway (hooks.admit: URL policy, DNS pinning, provider rules, request cap);
// a refused request is aborted before it leaves the browser. Large outputs go
// to the gateway through hooks.artifact; the returned summary stays small.
import {looksChallenged, nudgePointer, solvePageCaptchas, waitForSelfClear, wallState} from './page-captcha.mjs';

export const SCREENSHOT_MAX_BYTES = 2_000_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
// A wall on the warm-up visit gets this long to clear itself. Longer means the
// exit IP is burned for the site, and a fresh one is the better use of time.
const WARMUP_WALL_MS = 20_000;
// Time kept back for reading the page after a self-clear wait.
const AFTER_WALL_RESERVE_MS = 15_000;
const pause = (page, input, min, spread) => page.waitForTimeout(Math.min(min + Math.floor(Math.random() * spread), remainingMs(input)))
  .catch(() => {});

const remainingMs = input => Math.max(1, input.deadline - Date.now());
// Pages that fill themselves in after the document loads (search results, feeds,
// listings) are read once they stop changing: the page's element count steady
// and none of its data requests (XHR, fetch) started, finished or open for
// CONTENT_QUIET_MS, or when content_wait_ms runs out.
const CONTENT_QUIET_MS = 1500;
// After a scroll, lazy content starts loading at once, so a shorter quiet spell will do.
const SCROLL_QUIET_MS = 600;
const CONTENT_POLL_MS = 250;
// Lists that load more as the reader scrolls are scrolled through a screen at a
// time, at most this many screens.
const CONTENT_MAX_SCREENS = 20;
// A data request open this long is a long poll or a stream, not content on its way.
const CONTENT_LONG_REQUEST_MS = 5000;
const DATA_REQUESTS = new Set(['xhr', 'fetch']);
// The promise's value, or null if it takes longer than ms.
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms, null); })]);
  } finally {
    clearTimeout(timer);
  }
}

// Watches the page's data requests for waitForContent.
function watchDataRequests(page) {
  const open = new Map();
  const state = {open, lastActivity: Date.now()};
  const done = request => {
    if (open.delete(request)) state.lastActivity = Date.now();
  };
  page.on('request', request => {
    try {
      if (!DATA_REQUESTS.has(request.resourceType())) return;
      open.set(request, Date.now());
      state.lastActivity = Date.now();
    } catch { /* closed */ }
  });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return state;
}

// The page's element count, or null when the page does not answer within 2 s
// (page.evaluate has no timeout of its own).
const elementCount = page => within(page.evaluate(() => document.getElementsByTagName('*').length).catch(() => null), 2000);

// Waits until the page has stopped filling itself in, up to maxMs. Returns
// {settled, count}: settled is false when maxMs ran out first, count is the
// last element count seen (null if the page stopped answering).
async function waitForContent(page, requests, maxMs, quietMs) {
  const started = Date.now();
  let count = null;
  let changed = started;
  while (!page.isClosed()) {
    const now = Date.now();
    const next = await elementCount(page);
    if (next === null) return {settled: false, count};
    if (next !== count) {
      count = next;
      changed = now;
    }
    let busy = false;
    for (const opened of requests.open.values()) if (now - opened < CONTENT_LONG_REQUEST_MS) busy = true;
    const quietSince = Math.max(changed, busy ? now : requests.lastActivity);
    if (now - quietSince >= quietMs) return {settled: true, count};
    if (now - started >= maxMs) return {settled: false, count};
    await page.waitForTimeout(Math.min(CONTENT_POLL_MS, Math.max(1, maxMs - (now - started)))).catch(() => {});
  }
  return {settled: false, count};
}

// Reads a page the way a reader does: once it has settled, scrolls down a screen
// at a time with the mouse wheel and waits for what each screen loads. Stops at
// the bottom of the page once reaching it loads nothing more, after
// CONTENT_MAX_SCREENS, or when maxMs runs out. Returns {settled, ms, screens}.
async function readContent(page, requests, maxMs) {
  const started = Date.now();
  const left = () => maxMs - (Date.now() - started);
  let {settled} = await waitForContent(page, requests, maxMs, CONTENT_QUIET_MS);
  let screens = 0;
  while (settled && screens < CONTENT_MAX_SCREENS && left() > SCROLL_QUIET_MS && !page.isClosed()) {
    const view = await within(page.evaluate(() => ({y: scrollY, height: innerHeight, width: innerWidth,
      total: document.documentElement.scrollHeight})).catch(() => null), 2000);
    if (!view || view.y + view.height >= view.total - 2) break;
    try {
      if (!screens) await page.mouse.move(Math.round(view.width * (0.3 + Math.random() * 0.4)),
        Math.round(view.height * (0.3 + Math.random() * 0.4)), {steps: 4});
      await page.mouse.wheel(0, Math.round(view.height * (0.75 + Math.random() * 0.2)));
    } catch { break; }
    screens++;
    ({settled} = await waitForContent(page, requests, left(), SCROLL_QUIET_MS));
  }
  if (screens) await within(page.evaluate(() => scrollTo(0, 0)).catch(() => null), 2000);
  return {settled, ms: Date.now() - started, screens};
}

// The code a failed step reports. The pool accepts only lowercase codes
// (wire.mjs codePattern) and drops any result that carries another, page and
// all, so an engine's own error names are mapped into that form.
export const captureErrorCode = error => {
  if (/^[a-z][a-z0-9_]{1,100}$/.test(error?.code ?? '')) return error.code;
  const message = String(error?.message ?? '');
  const engine = /net::(ERR_[A-Z0-9_]+)/.exec(message)?.[1] ?? /\b(NS_ERROR_[A-Z0-9_]+)\b/.exec(message)?.[1];
  if (engine) return `browser_${engine.toLowerCase()}`.slice(0, 100);
  return error?.name === 'TimeoutError' ? 'browser_timeout' : 'browser_capture_error';
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
//         limits: {max_requests, max_dom_bytes, max_body_bytes}, locale, timezone,
//         warmup, self_clear_ms}
// warmup: visit the site's home page first and arrive at the URL from it, as a
//   visitor does (a cold landing on a deep URL is what bots do). A wall there
//   that does not clear itself ends the capture with that wall.
// self_clear_ms: how long a wall on the page may take to clear by itself before
//   any captcha is solved.
export async function capturePage(browser, input, hooks) {
  const result = {status: null, final_url: null, headers: null, requests: 0, blocked: 0, blocked_reasons: {},
    dom_bytes: 0, body_bytes: 0, screenshot_bytes: 0, captcha: [], wait_for: null, cookies: [], error: null,
    warmup: null, wall: null, content: null};
  let context;
  let page;
  let mainDocument = null;
  const setCookies = [];
  const block = reason => {
    result.blocked++;
    result.blocked_reasons[reason] = (result.blocked_reasons[reason] ?? 0) + 1;
  };
  try {
    // No viewport override: the window keeps the size the device identity
    // claims, so inner and outer sizes agree with the screen.
    context = await browser.newContext({
      serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false,
      locale: input.locale ?? 'en-US', timezoneId: input.timezone ?? 'America/New_York',
      viewport: null,
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
    const dataRequests = watchDataRequests(page);
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
    const status = () => mainDocument?.status ?? null;
    const target = new URL(input.url);
    const home = new URL('/', target).href;
    let referer;
    if (input.warmup && (target.pathname !== '/' || target.search)) {
      result.warmup = 'failed';
      try {
        await page.goto(home, {waitUntil: 'domcontentloaded', timeout: Math.min(NAVIGATION_TIMEOUT_MS, remainingMs(input))});
        await pause(page, input, 2000, 2000);
        const wall = await waitForSelfClear(page, status, Math.min(WARMUP_WALL_MS, Math.max(0, remainingMs(input) - 30_000)));
        result.warmup = !wall.cleared ? 'challenged' : wall.after_ms ? 'cleared' : 'passed';
        if (wall.cleared) {
          await nudgePointer(page);
          await pause(page, input, 1000, 2000);
          referer = page.url();
        }
      } catch { /* a home page that fails to load does not stop the visit */ }
    }
    if (result.warmup !== 'challenged') {
      // The page's own answer, never the home page's, is the result.
      mainDocument = null;
      try {
        // The browser follows redirects itself; a hop to a new host is checked by
        // the relay before it is tunnelled (see relay.mjs admitHost).
        await page.goto(input.url, {waitUntil: 'domcontentloaded', timeout: Math.min(NAVIGATION_TIMEOUT_MS, remainingMs(input)),
          ...(referer ? {referer} : {})});
      } catch (error) {
        result.error = captureErrorCode(error);
      }
      if (!page.isClosed() && input.settle_ms) await page.waitForTimeout(Math.min(input.settle_ms, remainingMs(input)));
      if (!page.isClosed() && input.self_clear_ms && (await wallState(page, status())).wall) {
        result.wall = await waitForSelfClear(page, status,
          Math.min(input.self_clear_ms, Math.max(0, remainingMs(input) - AFTER_WALL_RESERVE_MS)));
        if (result.wall.cleared) result.error = null;
      }
    }
    if (input.captcha && hooks.captcha && !page.isClosed() && result.warmup !== 'challenged') {
      const challenged = await looksChallenged(page, mainDocument?.status);
      result.captcha = await solvePageCaptchas(page, context, hooks, {deadline: input.deadline, settleMs: input.settle_ms ?? 0, challenged});
      if (result.captcha.some(solve => solve.outcome === 'passed')) result.error = null;
    }
    // Only a page that answered is waited on; a wall that stayed has nothing more to show.
    if (input.content_wait_ms && !page.isClosed() && result.warmup !== 'challenged'
      && mainDocument?.status >= 200 && mainDocument.status < 300) {
      result.content = await readContent(page, dataRequests,
        Math.min(input.content_wait_ms, Math.max(0, remainingMs(input) - AFTER_WALL_RESERVE_MS)));
    }
    if (input.wait_for && !page.isClosed() && result.warmup !== 'challenged') {
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
    result.error ??= captureErrorCode(error);
    return result;
  } finally {
    await context?.close().catch(() => {});
  }
}
