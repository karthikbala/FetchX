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
const project = { id: 'cp_00000000-0000-4000-8000-000000000001', name: 'INR fixture' };
const packs = {
  inr: [17500, 75000, 180000, 900000].map((amount_minor, index) => ({ id: ['credits-10000-inr', 'credits-50000-inr', 'credits-150000-inr', 'credits-1000000-inr'][index], name: ['10,000 credits', '50,000 credits', '150,000 credits', '1,000,000 credits'][index], amount_minor, currency: 'inr', credits: [10000, 50000, 150000, 1000000][index], saving: [null, '14.3%', '31.4%', '48.6%'][index] })),
  usd: [200, 800, 2000, 10000].map((amount_minor, index) => ({ id: ['credits-10000', 'credits-50000', 'credits-150000', 'credits-1000000'][index], name: ['10,000 credits', '50,000 credits', '150,000 credits', '1,000,000 credits'][index], amount_minor, currency: 'usd', credits: [10000, 50000, 150000, 1000000][index], saving: [null, '20%', '33.3%', '50%'][index] })),
};
let market = 'inr', pending = null, available = 0, missingCatalog = false, pausedCatalog = false, mixedCatalog = false, abortFirst = true;
let delayPricing, releasePricing;
const purchases = [], posts = [], hosted = [], errors = [], external = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { const url = new URL(request.url()); if (url.origin !== base && url.origin !== 'https://checkout.stripe.com') external.push(url.origin); });
await page.route('https://checkout.stripe.com/**', async route => {
  hosted.push(route.request().url());
  return route.fulfill({ status: 303, headers: { Location: base + '/app/billing?checkout=success' } });
});
await page.route('**/api/pricing', async route => {
  if (delayPricing) await delayPricing;
  return route.fulfill({ json: { currency: market, payment_method: market === 'inr' ? 'upi' : 'card', trial_credits: 1000, plans: packs[market] } });
});
await page.route('**/api/control/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname.slice('/api/control'.length);
  const send = (json, status = 200) => route.fulfill({ status, json });
  if (path === '/status') return send({ enabled: true, mail_configured: true });
  if (path === '/session') return send({ user: { email: 'inr-fixture@example.test' }, csrf_token: 'synthetic-csrf', projects: [project] });
  if (path === '/projects/' + project.id) return send({ project, access_profiles: [], capabilities: { routes: [] } });
  if (path === '/projects/' + project.id + '/keys') return send({ keys: [] });
  if (path === '/projects/' + project.id + '/requests') return send({ operations: [] });
  const credits = { granted: 1000, available: 1000, settled: 0, held: 0, reserved: 0, released: 0 };
  const paid_credits = { granted: available, available, used: 0, held: 0, reserved: 0, revoked_unused: 0, payment_hold: false };
  if (path.endsWith('/usage')) return send({ credits, paid_credits });
  if (path.endsWith('/billing')) return send({ credits, paid_credits, trial: { trial_target: 1000, grant_scope: 'account', grant_frequency: 'once', max_daily_operations: 25, eligible_routes: ['direct', 'datacenter'] }, stripe: {
    mode: 'live', currency: market, plans: missingCatalog ? [] : [...packs[market], ...(mixedCatalog ? [packs.usd[0]] : [])].map(plan => ({ ...plan, can_purchase: !pausedCatalog })), purchases,
    pending_checkout: pending && !['paid', 'failed', 'expired'].includes(pending.state) ? { ...pending, idempotency_key: pending.key, plan_id: pending.plan.id, currency: pending.plan.currency, amount_minor: pending.plan.amount_minor, credits: pending.plan.credits } : null,
    can_checkout: !pausedCatalog && (!pending || ['paid', 'failed', 'expired'].includes(pending.state)), can_resume_checkout: !!pending && ['awaiting_payment', 'creating'].includes(pending.state),
    ...(missingCatalog || pausedCatalog ? { checkout_unavailable_reason: 'stripe_currency_unavailable' } : {}),
  } });
  if (path.endsWith('/billing/stripe/checkout') && request.method() === 'POST') {
    const body = request.postDataJSON();
    assert.deepEqual(Object.keys(body).sort(), ['idempotency_key', 'plan_id']);
    assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf');
    const saved = pending && !['paid', 'failed', 'expired'].includes(pending.state);
    const plan = saved ? pending.plan : packs[market].find(plan => plan.id === body.plan_id);
    assert.ok(plan);
    assert.ok(saved || !pausedCatalog, 'Paused prices cannot create a fresh checkout');
    if (saved) assert.equal(body.idempotency_key, pending.key);
    else pending = { key: body.idempotency_key, plan, state: 'awaiting_payment' };
    assert.equal(body.plan_id, plan.id);
    posts.push({ ...body, currency: plan.currency });
    if (abortFirst) { abortFirst = false; return route.abort('failed'); }
    return send({ mode: 'live', state: pending.state, plan_id: plan.id, currency: plan.currency, amount_minor: plan.amount_minor, credits: plan.credits,
      checkout_url: 'https://checkout.stripe.com/c/pay/cs_live_InrSynthetic#fixture' });
  }
  if (path.includes('/billing/stripe/checkout/')) {
    assert.equal(path.split('/').at(-1), pending.key);
    return send({ mode: 'live', state: pending.state, plan_id: pending.plan.id, currency: pending.plan.currency, amount_minor: pending.plan.amount_minor, credits: pending.plan.credits });
  }
  return send({ error: { code: 'not_found', message: 'Fixture endpoint unavailable.' } }, 404);
});
const stripe = name => page.locator(`[data-stripe-${name}]`);
const go = path => page.goto(base + path);
async function openHostedCheckout(button, visits) {
  // The hosted request starts before the return document and automatic status
  // lookup finish. Observe that navigation before advancing the payment fixture.
  await Promise.all([
    page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() && frame.url() === base + '/app/billing?checkout=success' }),
    button.click(),
  ]);
  await expect.poll(() => hosted.length).toBe(visits);
  await expect(stripe('status')).toContainText('Payment confirmation is processing');
}
try {
  delayPricing = new Promise(resolve => { releasePricing = resolve; });
  await go('/pricing');
  await expect(page.locator('[data-pricing-status]')).toHaveText('Loading local pricing…');
  const loading = await page.locator('[data-local-pricing]').innerText();
  assert.ok(!loading.includes('$') && !loading.includes('₹'), 'Initial HTML must not flash another market currency');
  releasePricing(); delayPricing = null;
  await expect(page.locator('[data-local-pricing]')).toHaveAttribute('data-pricing-currency', 'inr');
  await expect(page.locator('[data-pricing-status]')).toHaveText('Prices in INR · Pay with UPI');
  for (const [credits, price, rate, discount] of [[10000, '₹175', '₹17.50 / 1,000 credits', 'Entry pack'], [50000, '₹750', '₹15.00 / 1,000 credits', '14.3% lower unit price'], [150000, '₹1,800', '₹12.00 / 1,000 credits', '31.4% lower unit price'], [1000000, '₹9,000', '₹9.00 / 1,000 credits', '48.6% lower unit price']]) {
    const card = page.locator(`[data-pricing-credits="${credits}"]`);
    await expect(card.locator('[data-pricing-amount]')).toHaveText(price);
    await expect(card.locator('[data-pricing-rate]')).toHaveText(rate);
    await expect(card.locator('[data-pricing-saving]')).toHaveText(discount);
    await expect(card.locator('[data-pricing-link]')).toHaveAttribute('href', `/signup?plan=credits-${credits}-inr`);
  }
  assert.ok(!(await page.locator('[data-local-pricing]').innerText()).includes('$'));
  for (const width of [320, 360, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `INR pricing overflow at ${width}`);
    const audit = await new AxeBuilder({ page }).include('[data-local-pricing]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(audit.violations, []);
    await page.screenshot({ path: `${out}/inr-pricing-${width}.png`, fullPage: true });
  }
  await page.getByRole('link', { name: 'Review package for 50,000 credits' }).click();
  await expect(page.locator('.pp-auth-switch')).toHaveAttribute('href', /plan=credits-50000-inr$/);
  await go('/app/billing?plan=credits-10000-inr');
  await expect(stripe('mode-help')).toContainText('Prices and payment are in INR. Pay with UPI');
  await expect(stripe('plans')).toContainText('₹175');
  await expect(stripe('plans')).toContainText('14.3% lower unit price');
  assert.ok(!(await stripe('plans').innerText()).includes('$'));
  await page.locator('[data-stripe-plan="credits-10000-inr"]').click();
  await expect(stripe('error')).toContainText('Checkout could not be confirmed');
  pausedCatalog = true;
  await page.locator('[data-refresh-workspace]').click();
  await expect(stripe('plans').locator('.pp-stripe-plan')).toHaveCount(4);
  await expect(stripe('plans')).toContainText('₹175');
  for (const button of await stripe('plans').locator('[data-stripe-plan]').all()) await expect(button).toBeHidden();
  await stripe('check').click();
  await expect(stripe('resume')).toContainText('Resume saved INR checkout');
  const firstKey = posts[0].idempotency_key;
  await openHostedCheckout(stripe('resume'), 1);
  assert.equal(posts[1].idempotency_key, firstKey);
  assert.equal(available, 0);
  assert.equal(posts[1].currency, 'inr', 'Paused INR checkout recovery keeps its original currency');
  pausedCatalog = false;
  pending.state = 'failed';
  await stripe('check').click();
  await expect(stripe('status')).toContainText('Payment failed. No credits were added.');
  await expect(page.locator('[data-paid-credits-available]')).toHaveText('0');
  await expect(page.locator('[data-stripe-plan="credits-10000-inr"]')).toBeEnabled();
  await openHostedCheckout(page.locator('[data-stripe-plan="credits-10000-inr"]'), 2);
  assert.notEqual(posts[2].idempotency_key, firstKey);
  pending.state = 'paid'; available = 10000;
  purchases.push({ ...pending.plan, plan_id: pending.plan.id, status: 'paid', paid_at: '2026-11-05T12:00:00Z' });
  await stripe('check').click();
  await expect(stripe('status')).toContainText('Payment confirmed. Your paid credit balance has been updated.');
  await expect(stripe('purchases')).toContainText('₹175 · Paid');
  await expect(page.locator('[data-paid-credits-available]')).toHaveText('10,000');
  pausedCatalog = true;
  await page.locator('[data-refresh-workspace]').click();
  await expect(stripe('status')).toContainText('INR checkout is currently unavailable');
  await expect(stripe('plans').locator('.pp-stripe-plan')).toHaveCount(4);
  await expect(stripe('plans')).toContainText('₹175');
  await expect(stripe('plans')).toContainText('48.6% lower unit price');
  for (const button of await stripe('plans').locator('[data-stripe-plan]').all()) await expect(button).toBeHidden();
  assert.equal(posts.length, 3, 'Displaying paused INR prices must not create checkout');
  assert.ok(!(await stripe('plans').innerText()).includes('$'));
  pausedCatalog = false; missingCatalog = true;
  await page.locator('[data-refresh-workspace]').click();
  await expect(stripe('status')).toContainText('INR checkout is currently unavailable');
  await expect(stripe('plans')).toBeEmpty();
  assert.ok(!(await stripe('billing').innerText()).includes('$'));
  missingCatalog = false; mixedCatalog = true;
  await page.locator('[data-refresh-workspace]').click();
  await expect(stripe('billing')).toBeHidden();
  mixedCatalog = false; market = 'usd';
  await go('/pricing');
  await expect(page.locator('[data-local-pricing]')).toHaveAttribute('data-pricing-currency', 'usd');
  await expect(page.locator('[data-pricing-credits="10000"] [data-pricing-amount]')).toHaveText('$2.00');
  assert.ok(!(await page.locator('[data-local-pricing]').innerText()).includes('₹'));
  await go('/app/billing');
  await expect(stripe('mode-help')).toContainText('Prices and payment are in USD. Pay by card');
  await expect(stripe('plans')).toContainText('$2.00');
  await expect(stripe('purchases')).toContainText('₹175 · Paid');
  await openHostedCheckout(page.locator('[data-stripe-plan="credits-10000"]'), 3);
  const originalUsdKey = pending.key;
  market = 'inr'; missingCatalog = true;
  await go('/app/billing');
  await expect(stripe('resume')).toContainText('Resume saved USD checkout');
  await openHostedCheckout(stripe('resume'), 4);
  assert.equal(pending.key, originalUsdKey, 'Country changes must recover the original checkout without replacing its currency or key');
  assert.equal(posts.at(-1).currency, 'usd');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('INR UI fixture passed: no price flash, country catalog, exact INR prices/discounts, 320/360/1200px, accessibility, plan hints, uncertain/pending/failed/success UPI, paused catalog display/recovery, no USD fallback, mixed-catalog refusal, USD control and original-currency recovery');
} finally { await browser.close(); }
