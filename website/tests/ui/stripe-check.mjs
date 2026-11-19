import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4328';
const out = process.env.TEST_OUTPUT_DIR || '.local/browser-reports';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();
const primary = { id: 'cp_00000000-0000-4000-8000-000000000001', name: 'Sandbox project' };
const secondary = { id: 'cp_00000000-0000-4000-8000-000000000002', name: 'Live fixture' };
const plan = { id: 'credits-50000', name: '50,000 credits', amount_minor: 800, currency: 'usd', credits: 50_000 };
const extraPlans = [
  { id: 'credits-10000', name: '10,000 credits', amount_minor: 200, currency: 'usd', credits: 10_000, can_purchase: true },
  { id: 'credits-150000', name: '150,000 credits', amount_minor: 2000, currency: 'usd', credits: 150_000, can_purchase: true },
  { id: 'credits-1000000', name: '1,000,000 credits', amount_minor: 10000, currency: 'usd', credits: 1_000_000, can_purchase: false },
];
const { id: plan_id, ...planDetails } = plan;
const purchase = status => ({ ...planDetails, plan_id, status, paid_at: '2026-12-15T12:00:00Z' });
const csrf = 'synthetic-csrf';
const checkoutUrl = mode => `https://checkout.stripe.com/c/pay/cs_${mode}_Synthetic#fixture`;
const billing = [
  { project: primary, mode: 'test', pending: null, trial: 20, purchased: 0, purchases: [] },
  { project: secondary, mode: 'live', pending: null, trial: 998, purchased: 10_000, purchases: [] },
];
const checkoutPosts = [], lookupKeys = [], unexpected = [], errors = [], consoleErrors = [], hostedVisits = [];
let signedIn = false, failFirstCheckout = true, hideSavedCheckout = false, invalidCheckout = true;
let delayedResponse, delayedLogout, delayedBalance;
const stripe = name => page.locator(`[data-stripe-${name}]`);
const balance = name => page.locator(`[data-credit-${name}]`);
const buy = () => page.locator(`[data-stripe-plan="${plan.id}"]`);
const go = path => page.goto(base + path);
const assertStoredCheckout = async (mode, project, key) => {
  assert.match(key, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const storage = await page.evaluate(() => ({ session: Object.entries(sessionStorage), local: Object.entries(localStorage) }));
  const saved = storage.session.find(([name]) => name === `fetchx-pending-checkout:${mode}:${project.id}`);
  assert.deepEqual(JSON.parse(saved?.[1] || 'null'), { idempotency_key: key, plan_id: plan.id });
  assert.deepEqual(storage.local, []);
  assert.ok(storage.session.every(([name]) => /^(?:fetchx-selected-project|fetchx-pending-checkout:(?:live|test):cp_[a-f0-9-]{36})$/.test(name)));
};
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text()); });
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === base) return route.fallback();
  if (url.href.split('#')[0] === checkoutUrl('test').split('#')[0]) {
    hostedVisits.push(url.origin);
    return route.fulfill({ status: 303, headers: { Location: base + '/app/billing?checkout=success' } });
  }
  unexpected.push(url.origin + url.pathname);
  return route.abort();
});
// Pin the public market to USD/card. /api/pricing follows Cloudflare's visitor
// country, so an unmocked run on a machine in India would render INR prices.
const usdPacks = [200, 800, 2000, 10000].map((amount_minor, index) => ({ id: ['credits-10000', 'credits-50000', 'credits-150000', 'credits-1000000'][index], name: ['10,000 credits', '50,000 credits', '150,000 credits', '1,000,000 credits'][index], amount_minor, currency: 'usd', credits: [10000, 50000, 150000, 1000000][index], saving: [null, '20%', '33.3%', '50%'][index] }));
await page.route('**/api/pricing', route => route.fulfill({ json: { currency: 'usd', payment_method: 'card', trial_credits: 1000, plans: usdPacks } }));
await page.route('**/api/control/**', async route => {
  const request = route.request(), url = new URL(request.url());
  const path = url.pathname.slice('/api/control'.length), method = request.method();
  const send = (json, status = 200) => route.fulfill({ status, json });
  const deny = (code, status = 404) => send({ error: { code, message: 'Fixture error' } }, status);
  const session = { user: { email: 'billing-fixture@example.test' }, csrf_token: csrf, projects: billing.map(value => value.project) };
  if (path === '/status') return send({ enabled: true, mail_configured: true });
  if (path === '/session') return signedIn ? send(session) : deny('session_required', 401);
  if (path === '/auth/code') return send({ challenge_id: 'fixture' });
  if (path === '/auth/verify') { signedIn = true; return send(session); }
  if (path === '/auth/logout') { if (delayedLogout) await delayedLogout; signedIn = false; return send({ logged_out: true }); }
  if (!signedIn) return deny('session_required', 401);
  const match = path.match(/^\/projects\/([^/]+)(.*)$/);
  const fixture = billing.find(value => value.project.id === match?.[1]);
  if (!fixture) return deny('project_not_found');
  const resource = match[2];
  if (delayedBalance && (resource === '/billing' || resource === '/usage')) await delayedBalance;
  const trial = fixture.trial ?? 20;
  const purchased = fixture.purchased ?? 0;
  const balance = { credits: trial + purchased, reserved: 0, available: fixture.hold ? 0 : trial + purchased, trial, purchased, held: !!fixture.hold };
  if (resource === '') return send({ project: fixture.project });
  if (resource === '/keys') return send({ keys: [] });
  if (resource === '/fetch') return send({ items: [], next_cursor: null });
  if (resource === '/usage') return send({ balance: { credits: balance.available, trial, purchased, reserved: 0, payment_hold: !!fixture.hold },
    period: { from: '2026-12-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }, used: { credits: 0, succeeded: 0, failed: 0, captcha_solved: 0 }, by_step: [], daily: [] });
  if (resource === '/billing') {
    if (fixture.billingReadFails) return deny('fixture_billing_unavailable', 503);
    const { mode, purchases } = fixture;
    const pending = hideSavedCheckout ? null : fixture.pending;
    const catalog = [extraPlans[0], { ...plan, can_purchase: true }, ...extraPlans.slice(1)];
    const stripe = { mode, currency: 'usd', plans: fixture.salesPaused ? [] : catalog, purchases,
      can_checkout: !fixture.salesPaused && !pending?.open && !fixture.hold,
      pending_checkout: pending?.open ? { plan_id: plan.id, idempotency_key: pending.key, state: pending.state } : null,
      ...(pending?.open ? { can_resume_checkout: !fixture.hold } : {}),
      ...(fixture.hold ? { checkout_unavailable_reason: 'paid_credit_payment_hold' } : {}) };
    return send({ balance, prices: { http: 1, http_residential: 5, browser: 10, browser_residential: 25, captcha: 10, residential_overage_per_mb: 5, residential_included_mb: { http_residential: 1, browser_residential: 5 } }, stripe });
  }
  if (resource === '/billing/stripe/checkout' && method === 'POST') {
    const body = request.postDataJSON(), { mode, project } = fixture;
    assert.equal(request.headers()['x-csrf-token'], csrf);
    assert.deepEqual(Object.keys(body).sort(), ['idempotency_key', 'plan_id']);
    assert.equal(body.plan_id, plan.id);
    await assertStoredCheckout(mode, project, body.idempotency_key);
    if (fixture.pending?.open) assert.equal(body.idempotency_key, fixture.pending.key);
    else fixture.pending = { key: body.idempotency_key, state: 'awaiting_payment', open: true };
    checkoutPosts.push({ project, key: body.idempotency_key });
    if (failFirstCheckout) { failFirstCheckout = false; return route.abort('failed'); }
    if (delayedResponse) await delayedResponse;
    return send({ mode, state: 'awaiting_payment', checkout_url: invalidCheckout ? 'https://checkout.stripe.com/redirect?fixture=1' : checkoutUrl(mode), plan_id: plan.id });
  }
  if (resource.startsWith('/billing/stripe/checkout/') && method === 'GET') {
    const key = resource.split('/').at(-1);
    lookupKeys.push({ project: fixture.project, key });
    if (hideSavedCheckout || key !== fixture.pending?.key) return deny('stripe_checkout_not_found');
    return send({ mode: fixture.mode, state: fixture.pending.state, plan_id: plan.id });
  }
  unexpected.push(path);
  return deny('unknown_route');
});

try {
  await go('/pricing');
  const trialCard = page.locator('.mkt-plan').filter({ has: page.getByRole('heading', { name: 'Free trial', exact: true }) });
  await expect(trialCard.locator('.mkt-plan-price')).toHaveText('$0.00');
  await expect(trialCard).toContainText('1,000 trial credits');
  await expect(trialCard).toContainText('Once per account');
  await expect(trialCard.getByRole('link', { name: 'Start free' })).toHaveAttribute('href', '/signup');
  for (const [name, price, rate] of [['10,000 credits', '$2.00', '$0.20 / 1,000 credits'], ['50,000 credits', '$8.00', '$0.16 / 1,000 credits'], ['150,000 credits', '$20.00', '$0.1333 / 1,000 credits'], ['1,000,000 credits', '$100.00', '$0.10 / 1,000 credits']]) {
    const card = page.locator('.mkt-plan').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card.locator('.mkt-plan-price')).toHaveText(price);
    await expect(card.locator('.mkt-plan-credits strong')).toHaveText(rate);
  }
  await page.screenshot({ path: `${out}/credit-pricing-desktop.png`, fullPage: true });
  await page.getByRole('link', { name: 'Review package for 50,000 credits' }).click();
  await expect(page.locator('.pp-auth-switch')).toHaveAttribute('href', /\/login\?view=billing&plan=credits-50000$/);
  await page.locator('[data-signup-email] input').fill('billing-fixture@example.test');
  await page.locator('[data-signup-email] button').click();
  await page.locator('[data-signup-verify] input').fill('12345678');
  await page.locator('[data-signup-verify] button').click();
  await expect(page).toHaveURL(base + '/app/billing?plan=credits-50000');
  await expect(stripe('mode')).toHaveText('STRIPE SANDBOX');
  await expect(balance('total')).toHaveText(['20', '20']);
  await expect(balance('trial')).toHaveText(['20', '20']);
  await expect(balance('purchased')).toHaveText(['0', '0']);
  await expect(page.locator('.pp-stripe-plan-preferred')).toContainText('50,000 credits');
  await expect(stripe('plans')).toContainText('$0.16 / 1,000 credits');
  await expect(page.locator('[data-stripe-plan="credits-1000000"]')).toBeHidden();
  await expect(stripe('plans')).toContainText('Currently unavailable for this project.');
  assert.equal(checkoutPosts.length, 0, 'A plan hint must not start a checkout');
  for (const width of [320, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const audit = await new AxeBuilder({ page }).include('[data-stripe-billing]').include('.pp-credit-summary').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(audit.violations, [], `Billing accessibility at ${width}px`);
  }
  await expect(stripe('plans')).toHaveCSS('display', 'grid');

  // A lost checkout response keeps its key; the saved checkout resumes with the same key.
  await buy().click();
  await expect(stripe('error')).toContainText('Checkout could not be confirmed');
  await expect(buy()).toBeHidden();
  hideSavedCheckout = true;
  await go('/app/billing?checkout=success');
  await expect(stripe('status')).toContainText('saved checkout is still unconfirmed');
  await expect(stripe('resume')).toBeVisible();
  hideSavedCheckout = false;
  await go('/app/billing?checkout=success');
  await expect(stripe('status')).toContainText('Payment confirmation is processing');
  assert.equal(checkoutPosts.length, 1);
  assert.equal(lookupKeys.at(-1).key, checkoutPosts[0].key);
  await page.evaluate(() => { for (const key of Object.keys(sessionStorage)) if (key.startsWith('fetchx-pending-checkout:')) sessionStorage.removeItem(key); });
  await go('/app/billing?checkout=cancelled');
  await expect(stripe('status')).toContainText('saved checkout is still available');
  await stripe('resume').click();
  await expect(stripe('error')).toContainText('invalid Stripe link');
  assert.equal(hostedVisits.length, 0);
  invalidCheckout = false;
  await stripe('resume').click();
  await expect.poll(() => hostedVisits.length).toBe(1);
  await expect(stripe('status')).toContainText('Payment confirmation is processing');
  assert.equal(checkoutPosts[1].key, checkoutPosts[0].key);
  assert.equal(checkoutPosts[2].key, checkoutPosts[0].key);
  billing[0].pending = { ...billing[0].pending, state: 'test_paid_unapplied', open: false };
  billing[0].purchases.push(purchase('test_paid_unapplied'));
  await expect(stripe('status')).toContainText('Test payment confirmed');
  await expect(balance('total')).toHaveText(['20', '20']);
  await expect(stripe('purchases')).toContainText('50,000 credits · $8.00 · Test payment');
  await expect(buy()).toBeEnabled();
  billing[0].salesPaused = true;
  await page.locator('[data-refresh-workspace]').click();
  await expect(stripe('status')).toContainText('Buying credits is currently unavailable');
  await expect(buy()).toHaveCount(0);

  // Switching projects mid-load shows loading, then the other project's live billing.
  const select = page.locator('[data-project-select]');
  let releaseBalance;
  delayedBalance = new Promise(resolve => { releaseBalance = resolve; });
  await select.selectOption(secondary.id);
  await expect(balance('total')).toHaveText(['Loading…', 'Loading…']);
  releaseBalance();
  delayedBalance = null;
  await expect(stripe('mode')).toHaveText('LIVE BILLING');
  await expect(balance('total')).toHaveText(['10,998', '10,998']);
  await expect(balance('trial')).toHaveText(['998', '998']);
  await expect(balance('purchased')).toHaveText(['10,000', '10,000']);

  // A checkout answered after switching away is picked up when switching back.
  let release;
  delayedResponse = new Promise(resolve => { release = resolve; });
  await buy().click();
  await expect.poll(() => checkoutPosts.length).toBe(4);
  await select.selectOption(primary.id);
  await expect(stripe('mode')).toHaveText('STRIPE SANDBOX');
  release();
  await select.selectOption(secondary.id);
  await expect(stripe('status')).toContainText('awaiting payment');
  assert.equal(lookupKeys.at(-1).key, checkoutPosts[3].key);
  billing[1].pending = { ...billing[1].pending, state: 'paid', open: false };
  billing[1].purchases.push(purchase('paid'));
  billing[1].purchased += plan.credits;
  await stripe('check').click();
  await expect(stripe('status')).toContainText('Payment confirmed');
  await expect(balance('total')).toHaveText(['60,998', '60,998']);
  await expect(stripe('purchases')).toContainText('50,000 credits · $8.00 · Paid');
  billing[1].billingReadFails = true;
  await page.locator('[data-refresh-workspace]').click();
  await expect(page.locator('[data-page-error]')).toContainText('could not be loaded');
  billing[1].billingReadFails = false;
  await page.locator('[data-refresh-workspace]').click();
  await expect(balance('total')).toHaveText(['60,998', '60,998']);
  await page.screenshot({ path: `${out}/credit-billing-populated.png`, fullPage: true });

  // A payment hold stops checkout and spending.
  billing[1].hold = true;
  await page.locator('[data-refresh-workspace]').click();
  await expect(page.locator('[data-credit-hold]')).toBeVisible();
  await expect(balance('total')).toHaveText(['On hold', 'On hold']);
  await expect(stripe('status')).toContainText('Billing is on hold');
  await expect(buy()).toBeHidden();
  await go('/app/playground');
  await page.locator('[data-playground-form] input[name="url"]').fill('https://shop.example.com/');
  await expect(page.locator('[data-run-request]')).toBeDisabled();
  await go('/app/billing');
  billing[1].hold = false;
  await page.locator('[data-refresh-workspace]').click();
  await expect(balance('total')).toHaveText(['60,998', '60,998']);

  // Signing out during a checkout never navigates to Stripe afterwards.
  delayedResponse = new Promise(resolve => { release = resolve; });
  let releaseLogout;
  delayedLogout = new Promise(resolve => { releaseLogout = resolve; });
  await buy().click();
  await expect.poll(() => checkoutPosts.length).toBe(5);
  await page.locator('[data-logout]').click();
  await expect(stripe('billing')).toBeHidden();
  const lateCheckout = page.waitForResponse(response => response.url().endsWith('/billing/stripe/checkout'));
  release();
  await lateCheckout;
  releaseLogout();
  await expect(page).toHaveURL(base + '/login');
  assert.deepEqual(hostedVisits, ['https://checkout.stripe.com']);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  console.log('Stripe fixture passed: pricing, checkout recovery, project switching, confirmed purchase, payment hold and sign-out during checkout');
} finally {
  await browser.close();
}
