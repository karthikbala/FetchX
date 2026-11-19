// CAPTCHA handling inside the browser worker, on the live page. Detection reads
// public widget attributes only. Solutions come from the gateway (hooks.captcha)
// and are applied the way the widget itself would apply them:
//   Turnstile / reCAPTCHA v2  token into the widget's field, then its callback or form
//   DataDome                  the solved `datadome` cookie, then a reload
//   hCaptcha                  image tiles: screenshot, ask which tiles, click them
// No caller scripts, no guessed selectors, and an unsupported widget is reported
// rather than guessed at.
const SITE_KEY = /^[A-Za-z0-9_-]{10,200}$/;
const MIN_SOLVE_MS = 20_000;
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
export async function solvePageCaptchas(page, context, hooks, {deadline, settleMs = 0, maxSolves = 2}) {
  const remaining = () => Math.max(0, deadline - Date.now());
  const summaries = [];
  for (let solve = 0; solve < maxSolves; solve++) {
    let found;
    try { found = await detectCaptcha(page); } catch { break; }
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
        await context.addCookies([{name: cookie.name, value: cookie.value, url: page.url()}]);
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
