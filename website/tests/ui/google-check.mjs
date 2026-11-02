// Synthetic GIS responses exercise the browser contract without Google accounts,
// Google network calls, email delivery or source dispatch.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4328';
const out = process.env.TEST_OUTPUT_DIR || '.local/browser-reports';
const scriptUrl = 'https://accounts.google.com/gsi/client';
const clientId = '1234567890-synthetic-google-client.apps.googleusercontent.com';
const challengeId = '11111111-1111-4111-8111-111111111111';
const nonce = 'n'.repeat(43), credential = 'SYNTHETIC_GOOGLE_ID_TOKEN';
const user = { id: '22222222-2222-4222-8222-222222222222', email: 'synthetic@gmail.com' };
const project = { id: 'cp_33333333-3333-4333-8333-333333333333', name: 'Existing project', status: 'active' };
const browser = await chromium.launch({ headless: true });
const results = [], errors = [], violations = [];
await fs.mkdir(out, { recursive: true });

const fakeGoogle = `
window.__googleFixture = {initializations: [], renderings: []};
window.google = {accounts: {id: {
 initialize(options) { window.__googleFixture.initializations.push(options); window.__googleFixture.options = options; },
 renderButton(parent, options) {
  window.__googleFixture.renderings.push(options);
  const button = document.createElement('button'); button.type = 'button';
  button.textContent = 'Continue with Google'; button.style.width = options.width + 'px'; button.style.height = '40px';
  button.style.background = '#ffffff'; button.style.color = '#1f1f1f';
  button.addEventListener('click', () => { options.click_listener(); if (!window.__googleCancel) { window.__googleFixture.options.callback({credential: ${JSON.stringify(credential)}}); if (window.__googleDuplicate) window.__googleFixture.options.callback({credential: ${JSON.stringify(credential)}}); } });
  parent.replaceChildren(button);
 }
}}};`;

async function fixtureScreenshot(page, name) {
  await page.evaluate(() => {
    const label = document.createElement('div'); label.dataset.googleFixtureLabel = '';
    label.textContent = 'Synthetic Google sign-in fixture - no live Google account';
    Object.assign(label.style, { position: 'fixed', inset: '0 0 auto', zIndex: '10000', padding: '7px 12px', background: '#d7ff83', color: '#080d12', font: '12px sans-serif', textAlign: 'center' });
    document.body.append(label);
  });
  await page.screenshot({ path: out + '/' + name, fullPage: true });
  await page.locator('[data-google-fixture-label]').evaluate(node => node.remove());
}

async function scenario(name, options, run) {
  const context = await browser.newContext({ viewport: { width: options.width || 1440, height: 1000 } });
  const page = await context.newPage(), calls = [], external = [];
  let signedIn = false;
  page.on('pageerror', error => errors.push({ name, message: error.message }));
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(base) || url.startsWith('data:')) return route.continue();
    if (url === scriptUrl) { external.push(url); return options.scriptFailure ? route.abort('failed') : route.fulfill({ contentType: 'application/javascript', body: fakeGoogle }); }
    external.push(url); return route.abort('blockedbyclient');
  });
  await context.route('**/api/control/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/control', ''), body = request.postDataJSON();
    calls.push({ path, method: request.method(), body });
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const fail = (code, message, status = 401) => send({ error: { code, message } }, status);
    const session = () => ({ user, csrf_token: 'synthetic-google-csrf', projects: options.existing ? [project] : [] });
    if (path === '/status') return send({ enabled: true, mail_configured: true, google: { enabled: options.enabled !== false, client_id: options.enabled === false ? null : clientId }, api_base_url: 'https://api.fixture.example', capabilities: { native_http: true } });
    if (path === '/session') return signedIn ? send(session()) : fail('unauthorized', 'Sign in to continue.');
    if (path === '/auth/google/challenge') return send({ challenge_id: challengeId, nonce, client_id: clientId, expires_in: options.expiry || 300 });
    if (path === '/auth/google/verify') {
      assert.deepEqual(body, { challenge_id: challengeId, credential });
      if (options.failure) return fail(options.failure, 'The account service rejected this sign-in.');
      signedIn = true; return send(session());
    }
    if (path === '/auth/code') return send({ challenge_id: 'synthetic-email-challenge', expires_in: 600, accepted: true });
    if (path === '/auth/verify') {
      assert.equal(body.code, '12345678'); signedIn = true; return send(session());
    }
    if (path === '/projects/' + project.id) return send({ project, capabilities: { native_http: true, routes: ['direct'] }, access_profiles: [] });
    if (path.endsWith('/keys')) return send({ keys: [] });
    if (path.endsWith('/requests')) return send({ operations: [] });
    if (path.endsWith('/usage')) return send({ credits: { granted: 25, available: 25 }, gateway: { outcomes: {}, by_key_and_state: [] } });
    if (path.endsWith('/billing')) return send({ status: 'trial', credits: { available: 25 }, commercial_enabled: false });
    return fail('not_found', 'Unknown synthetic route.', 404);
  });
  try {
    await page.goto(base + (options.route || '/login'));
    await expect(page.locator('[data-signup-email] button')).toBeEnabled();
    await run({ page, calls, external });
    const saved = await page.evaluate(() => JSON.stringify({ session: Object.entries(sessionStorage), local: Object.entries(localStorage) }));
    assert.ok(!saved.includes(credential) && !saved.includes(nonce) && !saved.includes(user.email), 'Identity credentials must not enter browser storage');
    assert.ok(external.every(url => url === scriptUrl), 'Only the intercepted official GIS script may be requested');
    assert.ok(!calls.some(call => call.path === '/projects' && call.method === 'POST'), 'Google sign-in must not create projects');
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    violations.push({ name, violations: audit.violations.map(item => ({ id: item.id, impact: item.impact })) });
    results.push(name);
  } finally { await context.close(); }
}

try {
  const homeHeaders = (await fetch(base + '/')).headers;
  assert.ok(!homeHeaders.get('Content-Security-Policy').includes('accounts.google.com'), 'Marketing CSP must retain its original boundary');
  for (const path of ['/login', '/signup']) {
    const canonical = await fetch(base + path + '/', { redirect: 'manual' });
    assert.equal(canonical.status, 308, 'Trailing-slash auth entries must redirect to their GIS-enabled canonical page');
    assert.equal(new URL(canonical.headers.get('Location'), base).href, base + path);
    const headers = (await fetch(base + path)).headers, policy = headers.get('Content-Security-Policy');
    assert.equal(policy.split(',').length, 1, 'Auth CSP must replace, rather than append to, the restrictive global CSP');
    assert.ok(policy.includes('https://accounts.google.com/gsi/client') && policy.includes('https://accounts.google.com/gsi/style'));
    assert.ok(policy.includes("object-src 'none'") && policy.includes("frame-ancestors 'none'"));
    assert.equal(headers.get('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
  }
  await scenario('new Google account reaches explicit project creation', { route: '/signup', width: 360 }, async ({ page, calls }) => {
    const button = page.getByRole('button', { name: 'Continue with Google', exact: true });
    await expect(button).toBeVisible(); await button.focus(); await expect(button).toBeFocused();
    const configuration = await page.evaluate(() => window.__googleFixture.initializations.map(({ client_id, nonce, ux_mode, auto_select, button_auto_select }) => ({ client_id, nonce, ux_mode, auto_select, button_auto_select })));
    assert.deepEqual(configuration, [{ client_id: clientId, nonce, ux_mode: 'popup', auto_select: false, button_auto_select: false }]);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Google button must fit a mobile viewport');
    await fixtureScreenshot(page, 'google-signup-mobile-initial-fixture.png');
    await page.evaluate(() => { window.__googleDuplicate = true; });
    await page.keyboard.press('Enter'); await expect(page.locator('[data-signup-stage="2"]')).toBeVisible();
    assert.equal(calls.filter(call => call.path === '/auth/google/verify').length, 1);
    await page.screenshot({ path: out + '/google-signup-mobile.png', fullPage: true });
  });
  await scenario('existing Google account opens its workspace', { existing: true }, async ({ page }) => {
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
    await fixtureScreenshot(page, 'google-login-desktop-initial-fixture.png');
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await expect(page).toHaveURL(base + '/app'); await expect(page.locator('[data-user-email]')).toHaveText(user.email);
  });
  await scenario('cancelled Google selection leaves email login usable', {}, async ({ page, calls }) => {
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
    await page.evaluate(() => { window.__googleCancel = true; });
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await expect(page.locator('[data-google-status]')).toContainText('or continue with an email code');
    await page.locator('[data-signup-email] input').fill('synthetic@example.test'); await page.locator('[data-signup-email] button').click();
    await expect(page.locator('[data-signup-stage="1"]')).toBeVisible(); assert.equal(calls.filter(call => call.path === '/auth/google/verify').length, 0);
  });
  await scenario('email sign-in disposes an outstanding Google callback', {}, async ({ page, calls }) => {
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
    await page.evaluate(() => { window.__googleCancel = true; });
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await page.locator('[data-signup-email] input').fill('synthetic@example.test'); await page.locator('[data-signup-email] button').click();
    await expect(page.locator('[data-signup-stage="1"]')).toBeVisible();
    await page.locator('[data-signup-verify] input').fill('12345678'); await page.locator('[data-signup-verify] button').click();
    await expect(page.locator('[data-signup-stage="2"]')).toBeVisible();
    await page.evaluate(value => window.__googleFixture.options.callback({ credential: value }), credential);
    await expect(page.locator('[data-signup-stage="2"]')).toBeVisible();
    assert.equal(calls.filter(call => call.path === '/auth/google/verify').length, 0, 'A late Google response must not replace a completed email sign-in');
  });
  await scenario('Google script failure preserves email login', { scriptFailure: true }, async ({ page, calls }) => {
    await expect(page.locator('[data-google-error]')).toContainText('Continue with an email code');
    await expect(page.locator('[data-google-reload]')).toBeVisible();
    assert.equal(calls.filter(call => call.path === '/auth/google/challenge').length, 0);
    await expect(page.locator('[data-signup-email] button')).toBeEnabled();
  });
  await scenario('expired Google challenge offers an explicit reload', { expiry: 1 }, async ({ page, calls }) => {
    await expect(page.locator('[data-google-error]')).toContainText('expired');
    await expect(page.locator('[data-signup-email] button')).toBeEnabled();
    assert.equal(calls.filter(call => call.path === '/auth/google/verify').length, 0);
  });
  await scenario('external Google email requires email verification', { failure: 'google_email_verification_required' }, async ({ page, calls }) => {
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await expect(page.locator('[data-google-error]')).toContainText('Use an email code to verify this address');
    await expect(page.locator('[data-signup-email] button')).toBeEnabled();
    assert.equal(calls.filter(call => call.path === '/auth/google/verify').length, 1);
  });
  await scenario('rejected Google credential is not replayed by a late callback', { failure: 'google_verification_invalid' }, async ({ page, calls }) => {
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await expect(page.locator('[data-google-error]')).toContainText('expired or could not be verified');
    await page.evaluate(value => window.__googleFixture.options.callback({ credential: value }), credential);
    await expect(page.locator('[data-signup-email] button')).toBeEnabled();
    assert.equal(calls.filter(call => call.path === '/auth/google/verify').length, 1);
  });
  await scenario('unconfigured Google makes no identity-library request', { enabled: false }, async ({ page, calls, external }) => {
    await expect(page.locator('[data-google-signin]')).toBeHidden(); assert.equal(external.length, 0);
    assert.equal(calls.filter(call => call.path.startsWith('/auth/google/')).length, 0);
  });
  assert.deepEqual(errors, []); assert.ok(violations.every(result => result.violations.length === 0));
  const report = { checks: results, authHeadersVerified: true, violations, errors, liveGoogleRequests: 0, emailsSent: 0 };
  await fs.writeFile(out + '/google-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); }
