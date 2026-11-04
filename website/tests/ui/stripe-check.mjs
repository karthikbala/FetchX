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
const trialProfile = { id: 'trial', version: 1, origins: ['https://trial.example.com'], methods: ['GET'], proxy_classes: ['direct'], countries: [] };
const publicRef = { id: 'public-url-http', version: 1 };
const publicProfile = { ...publicRef, kind: 'public_url_http', origins: [], methods: ['GET', 'HEAD'], proxy_classes: ['datacenter', 'residential'], countries: ['US'], route_reservations: [
  { class: 'datacenter', country: 'US', paid_credit_reservation: { route_class: 'datacenter', block_bytes: 1_000_000, credits_per_block: 1, max_transfer_bytes: 1_000_000, reserved_credits: 1 } },
  { class: 'residential', country: 'US', paid_credit_reservation: { route_class: 'residential', block_bytes: 250_000, credits_per_block: 5, max_transfer_bytes: 250_000, reserved_credits: 5 } },
] };
const checkoutUrl = mode => `https://checkout.stripe.com/c/pay/cs_${mode}_Synthetic#fixture`;
const billing = [
  { project: primary, mode: 'test', pending: null, available: 0, purchases: [] },
  { project: secondary, mode: 'live', pending: null, available: 80, purchases: [], routeDown: true },
];
const paidFetches = [], paidLookups = [], checkoutPosts = [], lookupKeys = [], unexpected = [], errors = [], consoleErrors = [], hostedVisits = [];
let signedIn = false, failFirstCheckout = true, hideSavedCheckout = false, invalidCheckout = true;
let delayedResponse, delayedLogout;
let unknownPaidFetch;
const stripe = name => page.locator(`[data-stripe-${name}]`);
const buy = () => page.locator(`[data-stripe-plan="${plan.id}"]`);
const go = path => page.goto(base + path);
const assertStoredCheckout = async (mode, project, key) => {
  assert.match(key, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const storage = await page.evaluate(() => ({ session: Object.entries(sessionStorage), local: Object.entries(localStorage) }));
  const saved = storage.session.find(([name]) => name === `fetchx-pending-checkout:${mode}:${project.id}`);
  assert.deepEqual(JSON.parse(saved?.[1] || 'null'), { idempotency_key: key, plan_id: plan.id });
  assert.deepEqual(storage.local, []);
  assert.ok(storage.session.every(([name]) => /^(?:fetchx-selected-project|fetchx-pending-checkout:(?:live|test):cp_[a-f0-9-]{36}|fetchx-pending-operations:cp_[a-f0-9-]{36})$/.test(name)));
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
  const credits = { granted: 1000, available: 20, settled: 980, held: 0, reserved: 0, released: 0 };
  const trial = { trial_target: 1000, grant_scope: 'account', grant_frequency: 'once', max_daily_operations: 25, eligible_routes: ['direct', 'datacenter'] };
  const paid_credits = { unit: 'credits', granted: fixture.available + (fixture.used || 0) + (fixture.held || 0), available: fixture.available, reserved: 0, used: fixture.used || 0, held: fixture.held || 0, revoked_unused: 0, payment_hold: !!fixture.hold };
  const paidReady = fixture.mode === 'live' && !fixture.routeDown;
  if (resource === '') return send({ project: fixture.project, access_profiles: [trialProfile, ...(paidReady ? [publicProfile] : [])], capabilities: {
    routes: paidReady ? ['direct', 'datacenter', 'residential'] : ['direct'],
    paid_http: { public_url_access_profile: paidReady ? publicRef : null, proxy_classes: { datacenter: paidReady, residential: paidReady } },
  } });
  if (resource === '/keys') return send({ keys: [] });
  if (resource === '/requests') return send({ operations: [] });
  if (resource === '/usage') return send({ credits, paid_credits, trial });
  if (resource === '/billing') {
    const { mode, purchases } = fixture;
    const pending = hideSavedCheckout ? null : fixture.pending;
    const catalog = [extraPlans[0], { ...plan, can_purchase: true }, ...extraPlans.slice(1)].map(item => ({ ...item, can_purchase: item.can_purchase && !fixture.capacityDown }));
    const stripe = { mode, plans: fixture.salesPaused ? [] : catalog, purchases,
      can_checkout: !fixture.salesPaused && !pending?.open && !fixture.hold && !fixture.routeDown && !fixture.capacityDown,
      pending_checkout: pending?.open ? { plan_id: plan.id, idempotency_key: pending.key, state: pending.state } : null,
      ...(pending?.open ? { can_resume_checkout: !fixture.hold && !fixture.routeDown && !fixture.capacityDown } : {}),
      ...(fixture.routeDown ? { checkout_unavailable_reason: 'paid_credit_route_unavailable' } : fixture.capacityDown ? { checkout_unavailable_reason: 'paid_credit_capacity_unavailable' } : {}) };
    return send({ status: 'trial', credits, paid_credits, trial, commercial_enabled: mode === 'live' && !fixture.routeDown, stripe });
  }
  if (resource === '/fetch' && method === 'POST') {
    assert.ok(paidReady);
    const body = request.postDataJSON();
    assert.equal(request.headers()['x-csrf-token'], csrf);
    const { idempotency_key, ...actual } = body;
    assert.match(idempotency_key, /^console_[a-f0-9-]{36}$/);
    assert.deepEqual(actual, { access_profile: publicRef, url: 'https://example.com/', method: 'GET', proxy: { class: 'residential', country: 'US' }, max_transfer_mb: 1, max_credits: 20 });
    assert.ok(await page.evaluate(key => Object.values(sessionStorage).some(value => value.includes(key)), idempotency_key));
    paidFetches.push({ idempotency_key, ...actual });
    fixture.available -= 20;
    const details = { max_transfer_mb: 1, max_allowed_transfer_mb: 20, reserved_credits: 20 };
    const paid = { reserved_credits: 20, block_bytes: 250_000, credits_per_block: 5 };
    const result = { success: false, operation_id: `fixture-transfer-${paidFetches.length}`, idempotency_key, application_acceptance: 'not_evaluated' };
    if (paidFetches.length === 2) {
      fixture.held = 20;
      unknownPaidFetch = { ...result, state: 'unknown', error: { code: 'max_transfer_bytes_exceeded', message: 'The wire outcome is uncertain. Recover the saved operation using its original key.', details },
        usage: { wire_bytes: null, accounting: { paid_credits: { ...paid, state: 'held', used_credits: null } } } };
      return send(unknownPaidFetch);
    }
    fixture.used = 20;
    return send({ ...result, state: 'failed', error: { code: 'max_transfer_bytes_exceeded', message: 'The operation reached its bidirectional wire limit. max_transfer_mb sets the wire ceiling. The final debit is based on measured wire bytes.',
      details: { ...details, next: { max_transfer_mb: 1.25, max_credits: 25, requires_new_idempotency_key: true } } },
      usage: { wire_bytes: 1_000_000, accounting: { paid_credits: { ...paid, state: 'settled', used_credits: 20 } } } });
  }
  if (resource.startsWith('/fetch/') && method === 'GET') {
    const key = resource.slice('/fetch/'.length);
    paidLookups.push(key);
    return key === unknownPaidFetch?.idempotency_key ? send(unknownPaidFetch) : deny('operation_not_found');
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
  await go('/docs/fetch#paid-public-urls');
  const paidExample = page.locator('#paid-public-urls pre');
  await expect(paidExample).toContainText('"access_profile": {"id": "public-url-http", "version": 1}');
  await expect(paidExample).toContainText('"max_credits": 20');
  await expect(paidExample).not.toContainText('+  -H');
  await go('/pricing');
  const trialCard = page.locator('.mkt-plan').filter({ has: page.getByRole('heading', { name: 'Free trial', exact: true }) });
  await expect(trialCard.locator('.mkt-plan-price')).toHaveText('$0.00');
  await expect(trialCard).toContainText('1,000 trial credits');
  await expect(trialCard).toContainText('One-time per eligible account');
  await expect(trialCard.getByRole('link', { name: 'Start free' })).toHaveAttribute('href', '/signup');
  for (const [name, price, rate] of [['10,000 credits', '$2.00', '$0.20 / 1,000 credits'], ['50,000 credits', '$8.00', '$0.16 / 1,000 credits'], ['150,000 credits', '$20.00', '$0.1333 / 1,000 credits'], ['1,000,000 credits', '$100.00', '$0.10 / 1,000 credits']]) {
    const card = page.locator('.mkt-plan').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card.locator('.mkt-plan-price')).toHaveText(price);
    await expect(card.locator('.mkt-plan-credits strong')).toHaveText(rate);
  }
  await page.screenshot({ path: `${out}/credit-pricing-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 360, height: 850 });
  await page.screenshot({ path: `${out}/credit-pricing-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.getByRole('link', { name: 'Review package for 50,000 credits' }).click();
  await expect(page.locator('.pp-auth-switch')).toHaveAttribute('href', /\/login\?view=billing&plan=credits-50000$/);
  await page.locator('[data-signup-email] input').fill('billing-fixture@example.test');
  await page.locator('[data-signup-email] button').click();
  await page.locator('[data-signup-verify] input').fill('12345678');
  await page.locator('[data-signup-verify] button').click();
  await expect(page).toHaveURL(base + '/app/billing?plan=credits-50000');
  await expect(stripe('mode')).toHaveText('STRIPE SANDBOX');
  await expect(page.locator('[data-billing-policy]')).toContainText('1,000 trial credits once');
  await expect(page.locator('[data-trial-daily-limit]')).toHaveText('Project limit for scoped routes: 25 requests per day.');
  await expect(page.locator('.pp-stripe-plan-preferred')).toContainText('50,000 credits');
  await expect(stripe('plans')).toContainText('$0.16 / 1,000 credits');
  await expect(page.locator('[data-stripe-plan="credits-1000000"]')).toBeHidden();
  await expect(stripe('plans')).toContainText('Currently unavailable for this project.');
  assert.equal(checkoutPosts.length, 0, 'A plan hint must not initiate checkout');
  for (const width of [320, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const audit = await new AxeBuilder({ page }).include('[data-stripe-billing]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(audit.violations, [], `Billing accessibility at ${width}px`);
  }
  await page.screenshot({ path: `${out}/credit-billing-sandbox.png`, fullPage: true });

  await buy().click();
  await expect(stripe('error')).toContainText('Checkout could not be confirmed');
  await expect(buy()).toBeHidden();
  hideSavedCheckout = true;
  await go('/app/billing?checkout=success');
  await expect(stripe('status')).toContainText('saved checkout is still unconfirmed');
  await expect(stripe('resume')).toBeVisible();
  await expect(buy()).toBeHidden();
  hideSavedCheckout = false;
  await go('/app/billing?checkout=success');
  await expect(stripe('status')).toContainText('Payment confirmation is processing');
  await expect(page.locator('[data-credits-available]')).toHaveText('20');
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
  await expect(page.locator('[data-paid-credits-available]')).toHaveText('0');
  await expect(page.locator('[data-credits-available]')).toHaveText('20');
  await expect(stripe('purchases')).toContainText('50,000 credits · $8.00 · Test payment');
  await expect(buy()).toBeEnabled();
  billing[0].salesPaused = true;
  await page.locator('[data-refresh-workspace]').click();
  await expect(stripe('status')).toContainText('Paid credit checkout is currently unavailable');
  await expect(stripe('purchases')).toContainText('50,000 credits · $8.00 · Test payment');
  await expect(buy()).toHaveCount(0);

  const select = page.locator('[data-project-select]');
  await select.selectOption(secondary.id);
  await expect(stripe('mode')).toHaveText('LIVE BILLING');
  await expect(stripe('status')).toContainText('Checkout will open when a paid route is ready');
  await expect(buy()).toBeHidden();
  await expect(page.locator('[data-paid-credits-use]')).toBeHidden();
  await page.screenshot({ path: `${out}/credit-billing-route-unavailable.png`, fullPage: true });
  await go('/app/playground');
  await expect(page.locator('[data-request-profile]')).toHaveValue('trial@1');
  await expect(page.locator('[data-request-profile] option[value="public-url-http@1"]')).toHaveCount(0);
  await expect(page.locator('[data-paid-transfer]')).toBeHidden();
  await go('/app/billing');
  await expect(stripe('mode')).toHaveText('LIVE BILLING');
  billing[1].routeDown = false;
  billing[1].capacityDown = true;
  await page.locator('[data-refresh-workspace]').click();
  await expect(stripe('status')).toContainText('Paid route capacity is currently unavailable');
  await expect(buy()).toBeHidden();
  billing[1].capacityDown = false;
  await page.locator('[data-refresh-workspace]').click();
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
  billing[1].available = 50_080;
  await stripe('check').click();
  await expect(stripe('status')).toContainText('Payment confirmed');
  await expect(page.locator('[data-paid-credits-available]')).toHaveText('50,080');
  await expect(page.locator('[data-credits-available]')).toHaveText('20');
  await expect(stripe('purchases')).toContainText('50,000 credits · $8.00 · Paid');
  await expect(page.locator('[data-paid-credits-use] a[href="/docs/fetch#paid-public-urls"]')).toBeVisible();
  await page.screenshot({ path: `${out}/credit-billing-populated.png`, fullPage: true });
  await page.setViewportSize({ width: 360, height: 850 });
  await page.screenshot({ path: `${out}/credit-billing-mobile.png`, fullPage: true });
  await page.locator('[data-paid-credits-use] a[href="/app/playground"]').click();
  await expect(page.locator('[data-request-profile]')).toHaveValue('trial@1');
  await expect(page.locator('[data-paid-transfer]')).toBeHidden();
  await page.locator('[data-request-profile]').selectOption('public-url-http@1');
  await expect(page.locator('[data-request-route]')).toHaveValue('datacenter');
  await expect(page.locator('[data-transfer-quote]')).toContainText('Default 1 MB. Reserves up to 1 credit.');
  await page.locator('[data-max-transfer]').fill('20');
  await page.locator('[data-request-route]').selectOption('residential');
  await expect(page.locator('[data-max-transfer]')).toHaveValue('');
  await expect(page.locator('[data-request-country]')).toHaveValue('US');
  await expect(page.locator('[data-transfer-quote]')).toContainText('Default 250 KB. Reserves up to 5 credits.');
  await page.locator('[data-max-transfer]').fill('1');
  await page.locator('[data-max-credits]').fill('20');
  await expect(page.locator('[data-transfer-quote]')).toContainText('Reserves up to 20 credits.');
  await page.locator('[data-inspector-tab="code"]').click();
  await expect(page.locator('[data-generated-code]')).toContainText('"max_transfer_mb": 1');
  await expect(page.locator('[data-generated-code]')).toContainText('"max_credits": 20');
  await page.locator('[data-inspector-tab="output"]').click();
  await page.locator('[data-request-url]').fill('http://example.com/');
  await page.locator('[data-run-request]').click();
  await expect(page.locator('[data-fetch-error]')).toContainText('Use a public HTTPS hostname');
  assert.equal(paidFetches.length, 0);
  await page.locator('[data-request-url]').fill('https://example.com/');
  await page.locator('[data-run-request]').click();
  await expect(page.locator('[data-response-state]')).toHaveText('Failed');
  await expect(page.locator('[data-response-note]')).toContainText('max_transfer_mb sets the wire ceiling');
  await expect(page.locator('[data-response-note]')).toContainText('The final debit is based on measured wire bytes.');
  await expect(page.locator('[data-response-transfer]')).toHaveText('Suggested limit for a new request is 1.25 MB with a 25-credit reservation. Use a new operation key.');
  await expect(page.locator('[data-max-transfer]')).toHaveValue('1');
  await expect(page.locator('[data-max-credits]')).toHaveValue('20');
  await expect(page.locator('[data-response-accounting]')).toHaveText('Paid credits reserved: 20. Paid credits used: 20.');
  assert.equal(paidFetches.length, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => { document.activeElement.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: `${out}/credit-playground-transfer-limit.png`, fullPage: true });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.screenshot({ path: `${out}/credit-playground-transfer-limit-desktop.png`, fullPage: true });
  await page.locator('[data-new-request]').click();
  await expect(page.locator('[data-response-transfer]')).toBeHidden();
  await page.locator('[data-max-transfer]').fill('1');
  await page.locator('[data-max-credits]').fill('20');
  await page.locator('[data-run-request]').click();
  await expect(page.locator('[data-response-state]')).toHaveText('Unknown');
  await expect(page.locator('[data-response-note]')).toContainText('Recover the saved operation using its original key.');
  await expect(page.locator('[data-response-transfer]')).toBeHidden();
  await expect(page.locator('[data-response-accounting]')).toContainText('The reservation remains held.');
  assert.notEqual(paidFetches[0].idempotency_key, paidFetches[1].idempotency_key);
  await page.locator('[data-recover-result]').click();
  await expect.poll(() => paidLookups).toEqual([paidFetches[1].idempotency_key]);
  await expect(page.locator('[data-response-state]')).toHaveText('Unknown');
  await expect(page.locator('[data-response-transfer]')).toBeHidden();
  assert.equal(paidFetches.length, 2);
  await go('/app/billing');
  await expect(page.locator('[data-paid-credits-available]')).toHaveText('50,040');
  await expect(page.locator('[data-paid-credits-held]')).toHaveText('20');
  billing[1].hold = true;
  billing[1].available = 0;
  await page.locator('[data-refresh-workspace]').click();
  await expect(page.locator('[data-paid-credits-hold]')).toBeVisible();
  await expect(buy()).toBeHidden();
  billing[1].hold = false;
  await page.locator('[data-refresh-workspace]').click();
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
  console.log('Stripe fixture passed: pricing intent, mobile accessibility, saved checkout recovery, signed status display, hosted URL validation, project and sign-out isolation, separate prepaid balance and trial credits, purchase history, route readiness and hold, measured transfer guidance and unknown recovery');
} finally {
  await browser.close();
}
