// Synthetic OAuth/navigation and account fixtures only. The real callback bridge
// is covered by github-proxy.test.ts; no GitHub account or network is used here.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4328';
const out = process.env.TEST_OUTPUT_DIR || '.local/browser-reports';
const state = 's'.repeat(43), code = 'SYNTHETIC_GITHUB_CODE', csrf = 'c'.repeat(43);
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'synthetic@example.test' };
const project = { id: 'cp_22222222-2222-4222-8222-222222222222', name: 'Existing project', status: 'active' };
const scriptUrl = 'https://accounts.google.com/gsi/client';
const clientId = '1234567890-synthetic-google-client.apps.googleusercontent.com';
const browser = await chromium.launch({ headless: true });
const checks = [], errors = [], audits = [];
await fs.mkdir(out, { recursive: true });
const fakeGoogle = `window.__googleFixture={options:null};window.google={accounts:{id:{initialize(options){window.__googleFixture.options=options;},renderButton(parent,options){const button=document.createElement('button');button.type='button';button.textContent='Continue with Google';button.style.cssText='background:#fff;color:#1f1f1f;width:100%;height:40px';button.addEventListener('click',()=>window.__googleFixture.options.callback({credential:'SYNTHETIC_GOOGLE_CREDENTIAL'}));parent.replaceChildren(button);}}}};`;

async function screenshot(page, name) {
  await page.evaluate(() => { const note = document.createElement('div'); note.dataset.fixtureNote = ''; note.textContent = 'Synthetic GitHub sign-in fixture — no live account'; Object.assign(note.style, { position: 'fixed', inset: '0 0 auto', zIndex: '10000', background: '#d7ff83', color: '#080d12', padding: '6px', textAlign: 'center', font: '12px sans-serif' }); document.body.append(note); });
  await page.screenshot({ path: out + '/' + name, fullPage: true, animations: 'disabled' });
  await page.locator('[data-fixture-note]').evaluate(node => node.remove());
}
async function scenario(name, options, run) {
  const context = await browser.newContext({ viewport: { width: options.width || 1440, height: 1000 } });
  const page = await context.newPage(), calls = [], external = [];
  let signedIn = !!options.signedIn, linked = !!options.linked, mode = 'login';
  page.on('pageerror', error => errors.push({ name, message: error.message }));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === base || url.protocol === 'data:') return route.continue();
    external.push(url.origin + url.pathname);
    if (url.href === scriptUrl && options.google) return route.fulfill({ contentType: 'application/javascript', body: fakeGoogle });
    if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/authorize') {
      assert.equal(url.searchParams.get('scope'), 'user:email'); assert.equal(url.searchParams.get('redirect_uri'), base + '/api/control/auth/github/callback');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('state'), state);
      const callback = base + '/api/control/auth/github/callback';
      return route.fulfill({ contentType: 'text/html', body: `<html lang="en"><title>Synthetic GitHub authorization</title><body><h1>Synthetic GitHub authorization</h1><p>Fixture only. No live GitHub account.</p><a href="${callback}?code=${code}&state=${state}">Authorize synthetic account</a><a href="${callback}?error=access_denied&state=${state}">Cancel synthetic authorization</a></body></html>` });
    }
    return route.abort('blockedbyclient');
  });
  await context.route('**/api/control/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/control', ''), body = request.postDataJSON();
    calls.push({ path, method: request.method(), body, csrf: request.headers()['x-csrf-token'] });
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const fail = (code, status = 401) => send({ error: { code, message: 'Synthetic rejection.' } }, status);
    const session = () => ({ user, projects: options.existing ? [project] : [], csrf_token: csrf, auth_methods: { github: linked } });
    if (path === '/status') return send({ enabled: true, mail_configured: options.mail !== false, github: { enabled: options.enabled !== false }, google: { enabled: !!options.google, client_id: options.google ? clientId : null }, api_base_url: 'https://api.fixture.example', capabilities: { native_http: true } });
    if (path === '/session') return signedIn ? send(session()) : fail('unauthorized');
    if (path === '/auth/github/start') {
      assert.deepEqual(Object.keys(body), ['mode']); assert.ok(['login', 'link'].includes(body.mode)); mode = body.mode;
      if (mode === 'link') { assert.equal(signedIn, true); assert.equal(request.headers()['x-csrf-token'], csrf); }
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      if (options.failure) return fail(options.failure, 409);
      const authorization = new URL('https://github.com/login/oauth/authorize');
      for (const [key, value] of Object.entries({ client_id: 'synthetic-client', redirect_uri: base + '/api/control/auth/github/callback', scope: 'user:email', state, code_challenge: 'p'.repeat(43), code_challenge_method: 'S256' })) authorization.searchParams.set(key, value);
      if (options.invalid === 'scope') authorization.searchParams.set('scope', 'repo');
      if (options.invalid === 'callback') authorization.searchParams.set('redirect_uri', 'https://attacker.example/callback');
      if (options.invalid === 'extra') authorization.searchParams.set('next', 'https://attacker.example');
      if (options.invalid === 'duplicate') authorization.searchParams.append('state', state);
      return send({ authorization_url: options.invalid === 'origin' ? 'https://attacker.example/login/oauth/authorize' : authorization.href, expires_in: options.invalid === 'expiry' ? 301 : 300 });
    }
    if (path === '/auth/github/callback') {
      const cancelled = url.searchParams.get('error') === 'access_denied';
      if (!cancelled && !options.completeFailure) { signedIn = true; linked = true; }
      const destination = cancelled ? '/login?github=github_cancelled' : options.completeFailure ? '/login?github=' + options.completeFailure : mode === 'link' ? '/login?github=linked' : options.existing ? '/app' : '/signup';
      return route.fulfill({ status: 303, headers: { Location: base + destination, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }, body: '' });
    }
    if (path === '/auth/google/challenge') return send({ challenge_id: '33333333-3333-4333-8333-333333333333', nonce: 'n'.repeat(43), client_id: clientId, expires_in: 300 });
    if (path === '/auth/google/verify') { signedIn = true; return send(session()); }
    if (path === '/auth/code') return send({ challenge_id: 'synthetic-email-challenge', expires_in: 600, accepted: true });
    if (path === '/auth/verify') { assert.equal(body.code, '12345678'); signedIn = true; return send(session()); }
    if (path === '/auth/logout') { assert.equal(request.headers()['x-csrf-token'], csrf); signedIn = false; return send({ logged_out: true }); }
    if (path === '/projects/' + project.id) return send({ project, capabilities: { native_http: true, routes: ['direct'] }, access_profiles: [] });
    if (path.endsWith('/keys')) return send({ keys: [] });
    if (path.endsWith('/requests')) return send({ operations: [] });
    if (path.endsWith('/usage')) return send({ credits: { granted: 25, available: 25 }, gateway: { outcomes: {}, by_key_and_state: [] } });
    if (path.endsWith('/billing')) return send({ status: 'trial', credits: { available: 25 }, commercial_enabled: false });
    throw new Error('Unexpected synthetic API route: ' + path);
  });
  try {
    await page.goto(base + (options.route || '/login'));
    await run({ page, calls, external });
    const saved = await page.evaluate(() => JSON.stringify({ session: Object.entries(sessionStorage), local: Object.entries(localStorage) }));
    for (const privateValue of [code, state, user.email, csrf, 'SYNTHETIC_GOOGLE_CREDENTIAL']) assert.ok(!saved.includes(privateValue), 'Identity values must not enter browser storage');
    assert.ok(!calls.some(call => ['/projects', '/auth/code'].includes(call.path) && call.method === 'POST') || options.email, 'Sign-in must not implicitly create projects or send email');
    assert.ok(external.every(url => [scriptUrl, 'https://github.com/login/oauth/authorize'].includes(url)), 'External traffic must be intercepted official auth endpoints only');
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    audits.push({ name, violations: audit.violations.map(item => ({ id: item.id, impact: item.impact })) });
    checks.push(name);
  } finally { await context.close(); }
}

try {
  await scenario('mobile signup offers GitHub alongside Google and email', { route: '/signup', width: 360, google: true }, async ({ page, calls }) => {
    await expect(page.getByRole('button', { name: 'Continue with GitHub', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeVisible();
    await expect(page.locator('[data-signup-email] button')).toBeEnabled();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot(page, 'github-signup-mobile-fixture.png');
    await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('link', { name: 'Authorize synthetic account' }).click();
    await expect(page).toHaveURL(base + '/signup'); await expect(page.locator('[data-signup-stage="2"]')).toBeVisible();
    await expect(page.locator('[data-user-email]')).toHaveText(user.email); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.locator('[data-github-connected]')).toBeVisible(); await expect(page.locator('[data-github-connect]')).toBeHidden();
    assert.equal(calls.filter(call => call.path === '/auth/github/start').length, 1);
    await screenshot(page, 'github-no-project-account-mobile-fixture.png');
  });
  await scenario('existing GitHub account opens existing project without mutation', { existing: true }, async ({ page }) => {
    await expect(page.locator('[data-github-start]')).toBeVisible();
    await screenshot(page, 'github-login-desktop-fixture.png');
    await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click(); await page.getByRole('link', { name: 'Authorize synthetic account' }).click();
    await expect(page).toHaveURL(base + '/app'); await expect(page.locator('[data-user-email]')).toHaveText(user.email); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    for (const width of [320, 360, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 }); await expect(page.getByRole('link', { name: 'Account & sign-in', exact: true })).toBeInViewport(); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeInViewport();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if ([360, 1440].includes(width)) await screenshot(page, 'github-workspace-account-' + width + '-fixture.png');
    }
    await page.getByRole('link', { name: 'Account & sign-in', exact: true }).click(); await expect(page).toHaveURL(base + '/login'); await expect(page.locator('[data-github-connected]')).toBeVisible();
  });
  await scenario('verified account explicitly connects GitHub and can sign out', { signedIn: true, existing: true }, async ({ page, calls }) => {
    await expect(page.locator('[data-auth-existing]')).toBeVisible(); await expect(page.locator('[data-user-email]')).toHaveText(user.email);
    await screenshot(page, 'github-connect-desktop-fixture.png');
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click(); await page.getByRole('link', { name: 'Authorize synthetic account' }).click();
    await expect(page).toHaveURL(base + '/login'); await expect(page.locator('[data-github-connected]')).toBeVisible();
    await expect(page.locator('[data-toast]')).toContainText('GitHub is connected');
    assert.equal(calls.filter(call => call.path === '/auth/github/start')[0].body.mode, 'link');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.locator('[data-github-start]')).toBeVisible(); await expect(page.locator('[data-auth-account]')).toBeHidden();
  });
  await scenario('verified account without projects keeps Connect GitHub and Sign out', { signedIn: true, width: 390 }, async ({ page, calls }) => {
    await expect(page.locator('[data-signup-stage="2"]')).toBeVisible(); await expect(page.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(1); await screenshot(page, 'github-connect-no-project-mobile-fixture.png');
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click(); await page.getByRole('link', { name: 'Authorize synthetic account' }).click();
    await expect(page.locator('[data-signup-stage="2"]')).toBeVisible(); await expect(page.locator('[data-github-connected]')).toBeVisible();
    assert.equal(calls.filter(call => call.path === '/auth/github/start')[0].body.mode, 'link');
  });
  await scenario('cancelled GitHub authorization returns safe text and email remains usable', { email: true }, async ({ page, calls }) => {
    await page.locator('[data-github-start]').click(); await page.getByRole('link', { name: 'Cancel synthetic authorization' }).click();
    await expect(page).toHaveURL(base + '/login'); await expect(page.locator('[data-page-error]')).toContainText('cancelled');
    await page.locator('[data-signup-email] input').fill('synthetic@example.test'); await page.locator('[data-signup-email] button').click();
    await expect(page.locator('[data-signup-stage="1"]')).toBeVisible(); assert.equal(calls.filter(call => call.path === '/auth/github/start').length, 1);
  });
  await scenario('email collision requires existing method then explicit connect', { completeFailure: 'github_account_link_required' }, async ({ page }) => {
    await page.locator('[data-github-start]').click(); await page.getByRole('link', { name: 'Authorize synthetic account' }).click();
    await expect(page).toHaveURL(base + '/login'); await expect(page.locator('[data-page-error]')).toContainText('Sign in with your existing method, then choose Connect GitHub');
  });
  for (const method of ['email', 'Google']) await scenario('email collision then ' + method + ' sign-in retains explicit Connect GitHub', { route: '/login?github=github_account_link_required', existing: true, google: method === 'Google', email: method === 'email' }, async ({ page, calls }) => {
    await expect(page.locator('[data-page-error]')).toContainText('Sign in with your existing method');
    if (method === 'email') { await page.locator('[data-signup-email] input').fill(user.email); await page.locator('[data-signup-email] button').click(); await page.locator('[data-signup-verify] input').fill('12345678'); await page.locator('[data-signup-verify] button').click(); }
    else await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await expect(page).toHaveURL(base + '/login'); await expect(page.locator('[data-auth-existing]')).toBeVisible(); await expect(page.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeFocused();
    await expect(page.locator('[data-user-email]')).toHaveText(user.email); assert.equal(calls.filter(call => call.path === '/auth/github/start').length, 0, 'Existing-method sign-in must not implicitly link GitHub');
    if (method === 'email') await screenshot(page, 'github-collision-connect-desktop-fixture.png');
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click(); await page.getByRole('link', { name: 'Authorize synthetic account' }).click();
    await expect(page).toHaveURL(base + '/login'); await expect(page.locator('[data-github-connected]')).toBeVisible(); assert.equal(calls.filter(call => call.path === '/auth/github/start')[0].body.mode, 'link');
  });
  await scenario('pending GitHub start prevents duplicate dispatch and preserves email after failure', { failure: 'github_unavailable', delay: 250, google: true }, async ({ page, calls }) => {
    await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeVisible();
    await page.evaluate(() => { window.__oldGoogleCallback = window.__googleFixture.options.callback; });
    await page.locator('[data-signup-email] input').fill('typed@example.test');
    await page.locator('[data-github-start]').click(); await expect(page.locator('[data-github-start]')).toBeDisabled(); await expect(page.locator('[data-signup-email] input')).toBeDisabled();
    await page.evaluate(() => { document.querySelector('[data-github-start]').click(); window.__oldGoogleCallback({ credential: 'LATE_SYNTHETIC_CREDENTIAL' }); });
    await expect(page.locator('[data-github-error]')).toContainText('could not be completed'); await expect(page.locator('[data-github-start]')).toBeFocused();
    await expect(page.locator('[data-signup-email] input')).toHaveValue('typed@example.test'); await expect(page.locator('[data-signup-email] button')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeVisible();
    await page.evaluate(() => window.__oldGoogleCallback({ credential: 'LATE_SYNTHETIC_CREDENTIAL' }));
    assert.equal(calls.filter(call => call.path === '/auth/github/start').length, 1); assert.equal(calls.filter(call => call.path === '/auth/google/verify').length, 0);
  });
  for (const invalid of ['origin', 'scope', 'callback', 'extra', 'duplicate', 'expiry']) await scenario('rejects invalid authorization response: ' + invalid, { invalid }, async ({ page, calls, external }) => {
    await page.locator('[data-signup-email] input').fill('typed@example.test'); await page.locator('[data-github-start]').click();
    await expect(page.locator('[data-github-error]')).toBeVisible(); await expect(page).toHaveURL(base + '/login'); await expect(page.locator('[data-signup-email] input')).toHaveValue('typed@example.test');
    assert.equal(external.length, 0); assert.equal(calls.filter(call => call.path === '/auth/github/start').length, 1);
  });
  await scenario('disabled GitHub retains email and Google sign-in', { enabled: false, google: true }, async ({ page, calls }) => {
    await expect(page.locator('[data-github-signin]')).toBeHidden(); await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeVisible(); await expect(page.locator('[data-signup-email] button')).toBeEnabled();
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click(); await expect(page.locator('[data-signup-stage="2"]')).toBeVisible();
    assert.equal(calls.filter(call => call.path.startsWith('/auth/github/')).length, 0);
  });
  await scenario('disabled GitHub preserves connected account identity and signout', { enabled: false, signedIn: true, linked: true }, async ({ page, calls }) => {
    await expect(page.locator('[data-github-connected]')).toBeVisible(); await expect(page.locator('[data-github-connect]')).toBeHidden(); await expect(page.locator('[data-user-email]')).toHaveText(user.email);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(); assert.equal(calls.filter(call => call.path.startsWith('/auth/github/')).length, 0);
  });
  await scenario('email login still completes and exposes explicit account linking', { email: true }, async ({ page }) => {
    await page.locator('[data-signup-email] input').fill(user.email); await page.locator('[data-signup-email] button').click(); await page.locator('[data-signup-verify] input').fill('12345678'); await page.locator('[data-signup-verify] button').click();
    await expect(page.locator('[data-signup-stage="2"]')).toBeVisible(); await expect(page.locator('[data-github-connect]')).toBeVisible(); await expect(page.locator('[data-user-email]')).toHaveText(user.email);
  });
  await scenario('GitHub alone works when email and Google are unavailable', { mail: false }, async ({ page }) => {
    await expect(page.locator('[data-github-start]')).toBeVisible(); await expect(page.locator('[data-signup-email] button')).toBeDisabled(); await expect(page.locator('[data-page-error]')).toBeHidden();
  });
  assert.deepEqual(errors, []); assert.ok(audits.every(audit => audit.violations.length === 0), JSON.stringify(audits));
  const report = { checks, audits, errors, liveGithubRequests: 0, emailsSent: 0, accountMutations: 0, callbackBridge: 'separate Workers unit tests; browser callback is synthetic' };
  await fs.writeFile(out + '/github-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); }
