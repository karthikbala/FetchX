// CAPTCHA handling inside the browser worker, on the live page. Detection reads
// public widget attributes only. Solutions come from the gateway (hooks.captcha)
// and are applied the way the widget itself would apply them:
//   Turnstile / reCAPTCHA v2  token into the widget's field, then its callback or form
//   DataDome                  the solved `datadome` cookie, then a reload
//   hCaptcha                  image tiles: screenshot, ask which tiles, click them
// No caller scripts, no guessed selectors, and an unsupported widget is reported
// rather than guessed at.
const SITE_KEY = /^[A-Za-z0-9_-]{10,200}$/;
// A solve is only started (and paid for) when it can finish: solvers usually
// answer in 15-40 s, and the page still has to submit and reload.
const MIN_SOLVE_MS = 30_000;
// Challenge pages (a block status or a challenge title) often load a script app that
// draws its captcha widget a few seconds later; look for one this long before giving up.
const CHALLENGE_WIDGET_WAIT_MS = 15_000;
const CHALLENGE_STATUS = new Set([401, 403, 405, 429, 503]);
const CHALLENGE_TITLE = /^(?:just a moment\.{0,3}|security check|robot check|verify (?:that )?you are (?:a )?human|bot or not\??|attention required|pardon our interruption|are you a (?:human|robot)\??|access denied|one more step)/i;

export async function looksChallenged(page, status) {
  if (CHALLENGE_STATUS.has(status)) return true;
  try { return CHALLENGE_TITLE.test((await page.title()).trim()); } catch { return false; }
}

// Is the page still a wall? A block status or challenge title, or a challenge
// frame. `hard` is a refusal no wait can clear (DataDome's blocked-visitor
// frame); `interactive` is a captcha that waits for a person (DataDome's
// captcha frame), as opposed to a device check that runs by itself.
export async function wallState(page, status) {
  if (page.isClosed()) return {wall: false, hard: false, interactive: false};
  const frame = await page.evaluate(() => {
    for (const element of document.querySelectorAll('iframe[src]')) {
      try {
        const url = new URL(element.src);
        if (url.hostname === 'captcha-delivery.com' || url.hostname.endsWith('.captcha-delivery.com')) {
          return {vendor: 'datadome', kind: url.searchParams.get('t'), path: url.pathname};
        }
      } catch { /* not a URL */ }
    }
    return null;
  }).catch(() => null);
  const wall = !!frame || await looksChallenged(page, status);
  const hard = frame?.kind === 'bv';
  return {wall, hard, interactive: !hard && !!frame?.path?.startsWith('/captcha')};
}

// A captcha frame does not go away by itself; it is given this long only in
// case the page is still settling.
const INTERACTIVE_WALL_MS = 8000;

// Lets a wall clear itself: interstitial device checks (DataDome, Cloudflare)
// pass on their own in a real browser on a clean IP, usually within seconds,
// and then reload into the page. Waits up to `ms`, moving the pointer now and
// then like a person reading. Returns {cleared, after_ms}; never throws.
export async function waitForSelfClear(page, status, ms) {
  const started = Date.now();
  let state = await wallState(page, status());
  if (!state.wall) return {cleared: true, after_ms: 0};
  const limit = () => (state.interactive ? Math.min(ms, INTERACTIVE_WALL_MS) : ms);
  while (!state.hard && Date.now() - started < limit() && !page.isClosed()) {
    await nudgePointer(page);
    await page.waitForTimeout(Math.min(2500, Math.max(1, limit() - (Date.now() - started)))).catch(() => {});
    await page.waitForLoadState('domcontentloaded', {timeout: 5000}).catch(() => {});
    state = await wallState(page, status());
    if (!state.wall) return {cleared: true, after_ms: Date.now() - started};
  }
  return {cleared: false, after_ms: Date.now() - started, ...(state.hard ? {hard: true} : {}),
    ...(state.interactive ? {interactive: true} : {})};
}

// A few small pointer moves (Camoufox's humanize draws the path).
export async function nudgePointer(page) {
  try {
    const size = page.viewportSize() ?? await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
    const x = Math.round(size.width * (0.2 + Math.random() * 0.6));
    const y = Math.round(size.height * (0.2 + Math.random() * 0.6));
    await page.mouse.move(x, y, {steps: 4});
  } catch { /* closed or no pointer */ }
}

async function waitForWidget(page, remaining) {
  const until = Date.now() + Math.min(CHALLENGE_WIDGET_WAIT_MS, Math.max(0, remaining() - MIN_SOLVE_MS));
  while (Date.now() < until) {
    await page.waitForTimeout(500).catch(() => {});
    if (page.isClosed()) return null;
    const found = await detectCaptcha(page).catch(() => null);
    if (found) return found;
  }
  return null;
}
const HCAPTCHA_ROUNDS = 3;

export async function detectCaptcha(page) {
  const found = await page.evaluate(() => {
    const attr = (el, name) => el?.getAttribute?.(name) ?? null;
    const frames = [...document.querySelectorAll('iframe[src]')].map(frame => {
      try { return new URL(frame.src); } catch { return null; }
    }).filter(Boolean);
    const datadome = frames.find(url => url.hostname === 'captcha-delivery.com' || url.hostname.endsWith('.captcha-delivery.com'));
    if (datadome) return {type: 'datadome', captcha_url: datadome.href};
    const turnstile = document.querySelector('.cf-turnstile[data-sitekey]')
      || [...document.querySelectorAll('[data-sitekey]')].find(el => el.querySelector('input[name="cf-turnstile-response"]')
        || el.closest('form')?.querySelector('input[name="cf-turnstile-response"]'));
    if (turnstile) return {type: 'turnstile', site_key: attr(turnstile, 'data-sitekey'), callback: attr(turnstile, 'data-callback')};
    const recaptcha = document.querySelector('.g-recaptcha[data-sitekey]');
    if (recaptcha) {
      return {type: 'recaptcha_v2', site_key: attr(recaptcha, 'data-sitekey'), invisible: attr(recaptcha, 'data-size') === 'invisible',
        callback: attr(recaptcha, 'data-callback')};
    }
    const anchor = frames.find(url => ['www.google.com', 'www.recaptcha.net'].includes(url.hostname) && url.pathname === '/recaptcha/api2/anchor');
    if (anchor) return {type: 'recaptcha_v2', site_key: anchor.searchParams.get('k'), invisible: anchor.searchParams.get('size') === 'invisible', callback: null};
    const hcaptcha = frames.find(url => url.hostname === 'hcaptcha.com' || url.hostname.endsWith('.hcaptcha.com'));
    if (hcaptcha || document.querySelector('.h-captcha[data-sitekey]')) return {type: 'hcaptcha'};
    return null;
  });
  if (!found) return null;
  if (['turnstile', 'recaptcha_v2'].includes(found.type) && !SITE_KEY.test(found.site_key ?? '')) return null;
  const callback = typeof found.callback === 'string' && /^[A-Za-z_$][\w$.]{0,100}$/.test(found.callback) ? found.callback : null;
  return {...found, callback};
}

export async function applyToken(page, found, token) {
  return page.evaluate(({type, callback, token}) => {
    const name = type === 'turnstile' ? 'cf-turnstile-response' : 'g-recaptcha-response';
    const fields = [...document.querySelectorAll(`textarea[name="${name}"],input[name="${name}"]`)];
    for (const field of fields) {
      field.value = token;
      field.dispatchEvent(new Event('input', {bubbles: true}));
      field.dispatchEvent(new Event('change', {bubbles: true}));
    }
    if (callback) {
      const fn = callback.split('.').reduce((value, part) => value?.[part], window);
      if (typeof fn === 'function') {
        fn(token);
        return 'callback';
      }
    }
    const form = fields.map(field => field.closest('form')).find(Boolean);
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return 'form';
    }
    return fields.length ? 'field_only' : 'no_field';
  }, {type: found.type, callback: found.callback, token});
}

function parseCookie(header) {
  const [pair, ...attributes] = header.split(';').map(part => part.trim());
  const index = pair.indexOf('=');
  const cookie = {name: pair.slice(0, index), value: pair.slice(index + 1)};
  for (const attribute of attributes) {
    const [key, value] = attribute.split('=');
    if (/^domain$/i.test(key) && value) cookie.domain = value;
    if (/^path$/i.test(key) && value) cookie.path = value;
  }
  return cookie;
}

// Runs in the page: sets a solved cookie for the page's own site.
function setPageCookie({name, value, domain, path}) {
  const scope = (domain ?? '').replace(/^\./, '').toLowerCase();
  const parts = [`${name}=${value}`, `Path=${path?.startsWith('/') ? path : '/'}`, 'Max-Age=31536000', 'SameSite=Lax'];
  if (scope && (location.hostname === scope || location.hostname.endsWith(`.${scope}`))) parts.push(`Domain=${scope}`);
  if (location.protocol === 'https:') parts.push('Secure');
  document.cookie = parts.join('; ');
}

async function settle(page, ms, remaining) {
  await page.waitForLoadState('domcontentloaded', {timeout: Math.min(15_000, remaining())}).catch(() => {});
  await page.waitForTimeout(Math.min(Math.max(ms, 1500), remaining())).catch(() => {});
}

async function solveHcaptcha(page, hooks, remaining) {
  const checkbox = page.frameLocator('iframe[src*="hcaptcha.com"][src*="frame=checkbox"]');
  await checkbox.locator('#checkbox').click({timeout: 5000}).catch(() => {});
  const challenge = page.frameLocator('iframe[src*="hcaptcha.com"][src*="frame=challenge"]');
  for (let round = 1; round <= HCAPTCHA_ROUNDS; round++) {
    if (remaining() < MIN_SOLVE_MS) return {outcome: 'captcha_deadline', rounds: round - 1};
    const checked = await checkbox.locator('#checkbox[aria-checked="true"]').count().catch(() => 0);
    if (checked) return {outcome: 'passed', rounds: round - 1};
    const grid = challenge.locator('.task-grid');
    if (!(await grid.count().catch(() => 0))) return {outcome: round === 1 ? 'captcha_unsupported_layout' : 'passed', rounds: round - 1};
    const instructions = (await challenge.locator('.prompt-text').first().innerText({timeout: 3000}).catch(() => '')).trim();
    const image = (await grid.screenshot({type: 'jpeg', quality: 80, timeout: 5000})).toString('base64');
    const tiles = challenge.locator('.task-image');
    const count = await tiles.count();
    const columns = count === 16 ? 4 : 3;
    const answer = await hooks.captcha({type: 'grid', website_url: page.url(), image, instructions, rows: Math.ceil(count / columns),
      columns, user_agent: await page.evaluate(() => navigator.userAgent)});
    for (const index of answer.click ?? []) {
      if (index >= 1 && index <= count) await tiles.nth(index - 1).click({timeout: 3000}).catch(() => {});
    }
    await challenge.locator('.button-submit').click({timeout: 3000}).catch(() => {});
    await page.waitForTimeout(2000);
  }
  const checked = await checkbox.locator('#checkbox[aria-checked="true"]').count().catch(() => 0);
  return {outcome: checked ? 'passed' : 'still_challenged', rounds: HCAPTCHA_ROUNDS};
}

// Detects and solves at most `maxSolves` CAPTCHAs on the page. Never throws.
export async function solvePageCaptchas(page, context, hooks, {deadline, settleMs = 0, maxSolves = 2, challenged = false}) {
  const remaining = () => Math.max(0, deadline - Date.now());
  const summaries = [];
  for (let solve = 0; solve < maxSolves; solve++) {
    let found;
    try { found = await detectCaptcha(page); } catch { break; }
    if (!found && solve === 0 && challenged) found = await waitForWidget(page, remaining);
    if (!found) break;
    const summary = {type: found.type, outcome: 'solving'};
    summaries.push(summary);
    if (remaining() < MIN_SOLVE_MS) {
      summary.outcome = 'captcha_deadline';
      break;
    }
    try {
      const userAgent = await page.evaluate(() => navigator.userAgent);
      if (found.type === 'datadome') {
        const answer = await hooks.captcha({type: 'datadome', website_url: page.url(), captcha_url: found.captcha_url, user_agent: userAgent});
        const cookie = parseCookie(answer.cookie);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(cookie.name) || /[\x00-\x1f\x7f]/.test(cookie.value)) {
          throw Object.assign(new Error('bad cookie'), {code: 'captcha_answer_invalid'});
        }
        // Camoufox's private browsing jar ignores the automation cookie API, so the
        // page sets the cookie itself, the way DataDome's own script does.
        await context.addCookies([{name: cookie.name, value: cookie.value, url: page.url()}]).catch(() => {});
        await page.evaluate(setPageCookie, cookie);
        await page.reload({waitUntil: 'domcontentloaded', timeout: Math.min(30_000, remaining())});
        summary.submitted_via = 'cookie';
      } else if (found.type === 'hcaptcha') {
        Object.assign(summary, await solveHcaptcha(page, hooks, remaining));
        if (summary.outcome !== 'passed') break;
        summary.submitted_via = 'tiles';
      } else {
        const answer = await hooks.captcha({type: found.type, website_url: page.url(), site_key: found.site_key,
          invisible: found.invisible === true, user_agent: userAgent});
        summary.submitted_via = await applyToken(page, found, answer.token);
      }
      await settle(page, settleMs, remaining);
      const again = await detectCaptcha(page).catch(() => null);
      summary.outcome = again && again.type === found.type ? 'still_challenged' : 'passed';
      if (summary.outcome !== 'passed') break;
    } catch (error) {
      summary.outcome = /^captcha_[a-z_]{1,60}$/.test(error?.code ?? '') ? error.code : 'captcha_failed';
      break;
    }
  }
  return summaries;
}
