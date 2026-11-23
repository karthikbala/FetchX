// Console UI checks against a synthetic control API. The gateway's own tests
// cover the real API; this checks the pages: sign-up, keys, the playground,
// request history, credits and sign-out, with accessibility audits.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4328';
const out = process.env.TEST_OUTPUT_DIR || '.local/browser-reports';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.TEST_CHROME_CHANNEL ? { channel: process.env.TEST_CHROME_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [], external = [], checks = [], accessibility = [], calls = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.push(request.url()); });

const user = { id: '11111111-1111-4111-8111-111111111111', email: 'private-fixture@example.test' };
const projects = [], keys = [], requests = new Map();
let webhookSecret = 'whsec_SYNTHETIC_UI_FIXTURE_0';
let signedIn = false, enabled = true, logoutFailure = false, charged = 0, nextOutcome = 'succeeded';
const TRIAL = 1000;
const token = () => 'fxk_SYNTHETIC_UI_FIXTURE_' + keys.length;
const session = () => ({ user, csrf_token: 'synthetic-csrf-ui-fixture', projects });
const balance = () => ({ credits: TRIAL - charged, reserved: 0, available: TRIAL - charged, trial: TRIAL, purchased: 0, held: false });
const testJpeg = await (async () => {
  const fixture = await context.newPage(); await fixture.setViewportSize({ width: 8, height: 8 });
  try { return (await fixture.screenshot({ type: 'jpeg' })).toString('base64'); } finally { await fixture.close(); }
})();
let n = 0;
function fetchResult(body) {
  const id = `aaaaaaaa-bbbb-4ccc-8ddd-${String(++n).padStart(12, '0')}`;
  const created_at = new Date(Date.UTC(2026, 10, 19, 10, n)).toISOString();
  const succeeded = nextOutcome === 'succeeded';
  if (succeeded) charged += 10;
  const result = {
    id, status: nextOutcome, idempotency_key: 'auto_' + id, url: body.url, created_at, finished_at: created_at, tags: body.tags ?? [],
    data: {
      status_code: succeeded ? 200 : 403, final_url: body.url, content_type: 'text/html', rendered: true, body_bytes: 60,
      headers: { 'content-type': 'text/html' }, cookies: [],
      ...(succeeded && body.formats?.includes('markdown') ? { markdown: '# Fixture <img src=x onerror=alert(1)>' } : {}),
      ...(succeeded && body.formats?.includes('screenshot') ? { screenshot: testJpeg } : {}),
      body: succeeded ? '<html><img src=x onerror=alert(1)></html>' : '<html>Access denied</html>', body_encoding: 'utf-8',
    },
    credits: { charged: succeeded ? 10 : 0, max: 160 },
    attempts: [
      { transport: 'http', class: 'direct', country: null, result: 'blocked', status_code: 403, ms: 300 },
      { transport: 'browser', class: 'residential', country: 'US', result: succeeded ? 'success' : 'blocked', status_code: succeeded ? 200 : 403, ms: 3000, captcha: succeeded ? ['turnstile:passed'] : undefined },
    ],
    skipped: [], fixes: ['user-agent'],
    error: succeeded ? null : { code: 'blocked', message: 'The site refused every route FetchX was allowed to try.',
      next: { action: 'retry_later', retry_after_seconds: 900, detail: 'Retry later, or allow more with max_attempts or max_credits.' } },
  };
  requests.set(id, result);
  return result;
}
const listItem = result => ({ id: result.id, status: result.status, url: result.url, created_at: result.created_at, credits: { charged: result.credits.charged },
  error_code: result.error?.code ?? null, tags: result.tags, idempotency_key: result.idempotency_key });

await context.route('**/api/control/**', async route => {
  const request = route.request(), method = request.method(), url = new URL(request.url()), path = url.pathname.replace('/api/control', '');
  const body = request.postDataJSON(); calls.push({ method, path: path + url.search, body });
  const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  const fail = (code, message, status = 400) => send({ error: { code, message } }, status);
  if (path === '/status') return send({ enabled, mail_configured: enabled, api_base_url: 'https://api.fixture.example' }, enabled ? 200 : 503);
  if (path === '/auth/code') return send({ challenge_id: 'synthetic-challenge', expires_in: 600, accepted: true });
  if (path === '/auth/verify') {
    if (body.code !== '12345678') return fail('verification_invalid', 'The verification code is invalid or expired.', 401);
    signedIn = true; return send(session());
  }
  if (path === '/session') return signedIn ? send(session()) : fail('unauthorized', 'Sign in to continue.', 401);
  if (!signedIn) return fail('unauthorized', 'Sign in to continue.', 401);
  if (method !== 'GET') assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf-ui-fixture', 'mutations carry the CSRF token');
  if (path === '/auth/logout') {
    if (logoutFailure) return fail('logout_unavailable', 'Sign out is temporarily unavailable. Try again.', 503);
    signedIn = false; return send({ logged_out: true });
  }
  if (path === '/projects' && method === 'POST') {
    const project = { id: 'cp_22222222-2222-4222-8222-22222222222' + projects.length, name: body.name, status: 'active', created_at: '2026-11-19T10:00:00Z' };
    projects.push(project); return send({ project });
  }
  if (path === '/projects') return send({ projects });
  const match = /^\/projects\/([^/]+)(.*)$/.exec(path);
  const project = match && projects.find(item => item.id === match[1]);
  if (!project) return fail('project_not_found', 'Project not found.', 404);
  const resource = match[2];
  if (!resource) return send({ project });
  if (resource === '/keys' && method === 'GET') return send({ keys });
  if (resource === '/webhook-secret' && method === 'GET') return send({ secret: webhookSecret });
  if (resource === '/webhook-secret/rotate' && method === 'POST') { webhookSecret = 'whsec_SYNTHETIC_UI_FIXTURE_1'; return send({ secret: webhookSecret }); }
  if (resource === '/keys' && method === 'POST') {
    keys.push({ id: `${keys.length + 1}`.repeat(8) + '-7777-4777-8777-' + `${keys.length + 1}`.repeat(12), name: body.name, scopes: body.scopes, created_at: '2026-11-19T10:00:00Z', revoked_at: null,
      limits: { credits_per_day: null, credits_per_month: null, expires_at: null, ...body.limits } });
    return send({ key: keys.at(-1), token: token() });
  }
  const limited = /^\/keys\/([0-9a-f-]{36})\/limits$/.exec(resource);
  if (limited && method === 'PUT') {
    const key = keys.find(item => item.id === limited[1]);
    if (!key) return fail('key_not_found', 'Key not found.', 404);
    key.limits = { credits_per_day: body.credits_per_day, credits_per_month: body.credits_per_month, expires_at: body.expires_at };
    return send({ key });
  }
  if (resource === '/usage') {
    const done = [...requests.values()];
    return send({ balance: { credits: balance().available, trial: TRIAL, purchased: 0, reserved: 0, payment_hold: false },
      period: { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' },
      used: { credits: charged, succeeded: done.filter(r => r.status === 'succeeded').length, failed: done.filter(r => r.status === 'failed').length, captcha_solved: done.filter(r => r.status === 'succeeded').length },
      by_step: charged ? [{ step: 'browser_residential', requests: charged / 10, credits: charged }] : [], daily: [] });
  }
  if (resource === '/billing') return send({ balance: balance(), prices: { http: 1, http_residential: 5, browser: 10, browser_residential: 25, captcha: 10, residential_overage_per_mb: 5, residential_included_mb: { http_residential: 1, browser_residential: 5 } } });
  if (resource === '/fetch' && method === 'POST') return send(fetchResult(body));
  if (resource === '/fetch' && method === 'GET') {
    const status = url.searchParams.get('status');
    const items = [...requests.values()].reverse().filter(r => !status || r.status === status).map(listItem);
    return send({ items, next_cursor: null });
  }
  const one = /^\/fetch\/([0-9a-f-]{36})$/.exec(resource);
  if (one && method === 'GET') return requests.has(one[1]) ? send(requests.get(one[1])) : fail('not_found', 'No request with that id.', 404);
  return fail('route_not_found', 'Unknown route.', 404);
});
const audit = async name => {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  accessibility.push({ name, violations: result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => node.target.join(' ')) })) });
};
const posts = () => calls.filter(call => call.method === 'POST' && call.path.endsWith('/fetch')).length;

try {
  await page.goto(base + '/signup');
  await page.locator('[data-signup-email] input').fill(user.email); await page.locator('[data-signup-email] button').click();
  await page.locator('[data-signup-verify] input').fill('00000000'); await page.locator('[data-signup-verify] button').click();
  await expect(page.locator('[data-page-error]')).toContainText('invalid or expired');
  await page.locator('[data-signup-verify] input').fill('12345678'); await page.locator('[data-signup-verify] button').click();
  await expect(page.locator('[data-signup-stage="2"]')).toBeVisible(); assert.equal(projects.length, 0, 'verifying an email creates no project');
  await page.locator('[data-signup-project] input').fill('Fixture project'); await page.locator('[data-signup-project] button').click();
  await expect(page.locator('[data-signup-stage="3"]')).toBeVisible();
  await page.locator('[data-signup-key] input[name="name"]').fill('My fixture key');
  await page.locator('[data-signup-key] input[value="usage:read"]').uncheck(); await page.locator('[data-signup-key] button').click();
  await expect(page.locator('[data-signup-secret]')).toContainText(token());
  assert.deepEqual(keys[0].scopes, ['fetch:write', 'fetch:read']);
  await page.locator('[data-signup-copy]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token());
  await audit('sign-up key reveal');
  checks.push('Sign-up: email code, explicit project, scoped key shown once and copied');

  await page.goto(base + '/app/playground');
  await expect(page.locator('[data-credit-total]').first()).toHaveText('1,000');
  const run = page.locator('[data-run-request]');
  await expect(run).toBeDisabled();
  await page.locator('[data-playground-form] input[name="url"]').fill('https://shop.example.com/p/42');
  await expect(run).toBeEnabled();
  await expect(page.locator('[data-generated-code]')).toContainText('https://api.fixture.example/v1/fetch');
  await page.locator('[data-playground-form] input[value="screenshot"]').check();
  await run.click();
  await expect(page.locator('[data-response-state]')).toHaveText('succeeded');
  await expect(page.locator('[data-result-credits]')).toHaveText('10');
  await expect(page.locator('[data-attempt-list] li')).toHaveCount(2);
  await expect(page.locator('[data-response-output]')).toContainText('<img src=x');
  assert.equal(await page.locator('.pp-response-panel [data-response-output] img').count(), 0, 'remote HTML is shown as text');
  const sent = calls.findLast(call => call.method === 'POST' && call.path.endsWith('/fetch')).body;
  assert.deepEqual(sent, { url: 'https://shop.example.com/p/42', formats: ['markdown', 'screenshot'], tags: ['console'] });
  await page.locator('[data-inspector-tab="screenshot"]').click(); await expect(page.locator('[data-browser-screenshot]')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await page.locator('[data-inspector-tab="output"]').focus(); await page.keyboard.press('ArrowRight'); await expect(page.locator('[data-inspector-tab="headers"]')).toBeFocused();
  for (const language of ['curl', 'javascript', 'python']) {
    await page.locator('[data-inspector-tab="code"]').click(); await page.locator('[data-code-language]').selectOption(language);
    await page.locator('[data-copy-code]').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.locator('[data-generated-code]').textContent());
  }
  await expect(page.locator('[data-credit-total]').first()).toHaveText('990');
  await audit('playground success');
  nextOutcome = 'failed';
  await page.locator('[data-playground-form] input[name="url"]').fill('https://walled.example.com/');
  await run.click();
  await expect(page.locator('[data-response-state]')).toHaveText('failed');
  await expect(page.locator('[data-response-note]')).toContainText('Retry later');
  await expect(page.locator('[data-result-credits]')).toHaveText('0');
  await expect(page.locator('[data-response-output]')).toContainText('Access denied');
  await expect(page.locator('[data-credit-total]').first()).toHaveText('990');
  assert.equal(posts(), 2);
  checks.push('Playground: success with markdown, attempts, screenshot, code samples; a failure shows the next step and costs nothing');

  await page.goto(base + '/app/requests');
  await expect(page.locator('.pp-request-link')).toHaveCount(2);
  await page.locator('[data-request-filter]').selectOption('failed');
  await expect(page.locator('.pp-request-link')).toHaveCount(1);
  await page.locator('.pp-request-link').first().click();
  await expect(page.locator('[data-request-dialog]')).toBeVisible();
  await expect(page.locator('[data-request-detail-status]')).toContainText('refused every route');
  await audit('request detail');
  await page.locator('[data-close-request]').click();
  assert.equal(posts(), 2, 'reading history sends nothing');
  checks.push('Requests: list, status filter and a read-only detail');

  await page.goto(base + '/app/billing');
  await expect(page.locator('[data-usage-credits]')).toHaveText('10');
  await expect(page.locator('[data-usage-failed]')).toHaveText('1');
  await expect(page.locator('[data-usage-steps]')).toContainText('Browser, residential IP');
  await expect(page.locator('[data-price-list]')).toContainText('Captcha solved');
  await audit('credits and usage');
  checks.push('Credits: one balance, usage by step and the price list');

  await page.goto(base + '/app/keys');
  await expect(page.locator('[data-key-secret]')).toHaveText('Concealed');
  await page.locator('[data-create-key] input[name="name"]').fill('Server key'); await page.locator('[data-create-key] button').click();
  await expect(page.locator('[data-key-dialog]')).toBeVisible(); await expect(page.locator('[data-key-secret]')).toHaveText(token());
  await page.locator('[data-close-key]').click(); await expect(page.locator('[data-key-secret]')).toHaveText('Concealed');
  assert.deepEqual(keys[1].scopes, ['fetch:write', 'fetch:read', 'usage:read']);
  assert.equal(calls.findLast(call => call.method === 'POST' && call.path.endsWith('/keys')).body.limits, undefined, 'a key without limits sends none');
  const serverKey = page.locator('[data-key-list] .pp-key-row').filter({ hasText: 'Server key' });
  await expect(serverKey).toContainText('no limits');
  await serverKey.getByRole('button', { name: 'Limits', exact: true }).click();
  await expect(page.locator('[data-limits-dialog]')).toBeVisible(); await expect(page.locator('[data-limits-key-name]')).toHaveText('Server key');
  await page.locator('[data-limit-day]').fill('2.5'); await page.locator('[data-key-limits] button[type="submit"]').click();
  await expect(page.locator('[data-limits-dialog]')).toBeVisible(); assert.equal(await page.locator('[data-limit-day]').evaluate(input => input.checkValidity()), false);
  assert.equal(calls.some(call => call.method === 'PUT'), false, 'a fractional limit is not sent'); assert.equal(keys[1].limits.credits_per_day, null);
  await page.locator('[data-limit-day]').fill('500'); await page.locator('[data-key-limits] button[type="submit"]').click();
  await expect(page.locator('[data-limits-dialog]')).toBeHidden(); await expect(serverKey).toContainText('500 credits a day');
  assert.deepEqual(keys[1].limits, { credits_per_day: 500, credits_per_month: null, expires_at: null });
  await page.locator('[data-create-key] input[name="name"]').fill('Scheduler key'); await page.locator('[data-create-limit-month]').fill('2000');
  await page.locator('[data-create-key] button[type="submit"]').click();
  await expect(page.locator('[data-key-dialog]')).toBeVisible(); await page.locator('[data-close-key]').click();
  assert.deepEqual(keys[2].limits, { credits_per_day: null, credits_per_month: 2000, expires_at: null });
  await expect(page.locator('[data-key-list] .pp-key-row').filter({ hasText: 'Scheduler key' })).toContainText('2,000 credits a month');
  const hook = page.locator('[data-webhook-secret-value]');
  await expect(hook).toHaveText('Concealed');
  await page.locator('[data-webhook-secret-show]').click(); await expect(hook).toHaveText('whsec_SYNTHETIC_UI_FIXTURE_0');
  await page.locator('[data-webhook-secret-rotate]').click(); await page.locator('[data-confirm-action]').click();
  await expect(hook).toHaveText('whsec_SYNTHETIC_UI_FIXTURE_1');
  await audit('keys');
  checks.push('Keys: three scopes, secret shown once and concealed on close; credit limits set on create and in the Limits dialog, a fractional limit refused; webhook secret shown and rotated after confirming');

  await page.setViewportSize({ width: 360, height: 800 });
  const signout = page.getByRole('button', { name: 'Sign out', exact: true });
  logoutFailure = true; await signout.click();
  await expect(page.locator('[data-page-error]')).toContainText('Sign out is temporarily unavailable'); assert.equal(signedIn, true);
  logoutFailure = false; await signout.click(); await expect(page).toHaveURL(base + '/login');
  await page.goto(base + '/app'); await expect(page.locator('[data-gate-title]')).toHaveText('Sign in to continue.');
  checks.push('Sign-out: a failure keeps the session, success returns to sign-in');
  enabled = false; await page.goto(base + '/signup');
  await expect(page.locator('[data-page-error]')).toContainText('not enabled');
  checks.push('An unconfigured service says so, with no simulated account data');

  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await fs.writeFile(out + '/product-checks.json', JSON.stringify({ checks, accessibility, errors, externalRequests: external }, null, 2));
  console.log(JSON.stringify({ checks, accessibility: accessibility.map(a => ({ name: a.name, violations: a.violations.length })) }));
  if (accessibility.some(result => result.violations.length)) { console.error(JSON.stringify(accessibility.filter(a => a.violations.length), null, 2)); process.exitCode = 1; }
} finally { await browser.close(); }
