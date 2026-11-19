import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {databaseUrl, openStore, PROJECT} from './helpers.mjs';
import {Ledger, prices, priceOf, stepFor, worstCaseOf} from '../src/billing/ledger.mjs';
import {Purchases, packCredits} from '../src/billing/purchases.mjs';
import {CaptchaSolver, captchaSettings} from '../src/captcha/solver.mjs';

const skip = !databaseUrl;

test('prices come from config and charge by the step that succeeded', () => {
  const table = prices({pricing: {browser: 12}});
  assert.equal(table.browser, 12);
  assert.equal(table.http, 1);
  assert.equal(stepFor({transport: 'http', class: 'direct'}), 'http');
  assert.equal(stepFor({transport: 'browser', class: 'residential'}), 'browser_residential');
  assert.equal(priceOf(table, {step: 'http', wireBytes: 50_000_000}), 1, 'no overage off residential');
  assert.equal(priceOf(table, {step: 'http_residential', wireBytes: 1_000_000}), 5);
  assert.equal(priceOf(table, {step: 'http_residential', wireBytes: 2_500_001}), 5 + 2 * 5);
  assert.equal(priceOf(table, {step: 'browser_residential', captchaSolved: true, wireBytes: 1000}), 35);
  assert.equal(worstCaseOf(table, 'browser_residential', {captcha: true, maxWireBytes: 30_000_000}), 25 + 10 + 25 * 5);
  assert.throws(() => prices({pricing: {http: -1}}), {code: 'pricing_configuration_invalid'});
  assert.equal(packCredits(200, 'usd'), 10_000);
  assert.equal(packCredits(17_500, 'inr'), 10_000);
  assert.equal(packCredits(201, 'usd'), null);
});

test('the balance is trial + purchases + adjustments - charges - reservations, and holds stop spending', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const ledger = new Ledger({store, config: {}});
  const purchases = new Purchases({store});
  assert.equal(ledger.metered('static'), false);
  assert.equal(await ledger.balance('static'), null);
  const grant = {project: PROJECT, mode: 'live', accountId: 'acct_test', checkoutSessionId: 'cs_live_1', paymentIntentId: 'pi_1',
    credits: 10_000, amountMinor: 200, currency: 'usd'};
  await store.tx(c => purchases.grantPaidCredits(c, grant));
  assert.equal(await store.tx(c => purchases.grantPaidCredits(c, grant)), false, 'a replayed event never grants twice');
  await store.tx(c => ledger.adjust(c, {project: PROJECT, credits: -100, note: 'correction', actor: 'ops'}));
  assert.deepEqual(await ledger.balance(PROJECT), {credits: 10_000, reserved: 0, available: 10_000, trial: 100, purchased: 10_000, held: false});
  const request = randomUUID();
  assert.equal(await store.tx(c => ledger.reserve(c, {project: PROJECT, request, minimum: 1, ceiling: 60})), 60);
  assert.equal((await ledger.balance(PROJECT)).available, 9_940);
  assert.equal(await store.tx(c => ledger.charge(c, {project: PROJECT, request, step: 'browser', credits: 99, captcha: true})), 60,
    'never more than the reservation');
  assert.equal((await ledger.balance(PROJECT)).credits, 9_940);
  const failed = randomUUID();
  await store.tx(c => ledger.reserve(c, {project: PROJECT, request: failed, minimum: 1, ceiling: 25}));
  await store.tx(c => ledger.release(c, {request: failed}));
  assert.equal((await ledger.balance(PROJECT)).available, 9_940, 'a released reservation costs nothing');
  const usage = await ledger.usage(PROJECT, {from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000)});
  assert.deepEqual(usage.by_step, [{step: 'browser', requests: 1, credits: 60}]);
  assert.equal(usage.captcha_solved, 1);
  // A refund revokes the purchase; a dispute holds spending.
  await store.tx(c => purchases.revokePaidCredits(c, grant));
  assert.equal((await ledger.balance(PROJECT)).credits, -60);
  await store.tx(c => purchases.setPaymentHold(c, {project: PROJECT, mode: 'live', accountId: 'acct_test', holdId: 'dispute:dp_1', active: true}));
  assert.equal(await purchases.paymentHeld(PROJECT), true);
  await assert.rejects(store.tx(c => ledger.reserve(c, {project: PROJECT, request: randomUUID(), minimum: 1, ceiling: 1})), {code: 'payment_hold'});
  await store.tx(c => purchases.setPaymentHold(c, {project: PROJECT, mode: 'live', accountId: 'acct_test', holdId: 'dispute:dp_1', active: false}));
  await assert.rejects(store.tx(c => ledger.reserve(c, {project: PROJECT, request: randomUUID(), minimum: 1, ceiling: 1})),
    error => error.code === 'insufficient_credits' && error.details.needed === 1);
});

test('the captcha solver reserves within budget, passes DataDome the attempt proxy, and stores no token', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const config = {captcha: {enabled: true, apiKey: 'synthetic-key', maxTaskMicroUsd: 3000, maxDailyMicroUsd: 7000, maxTotalMicroUsd: 100_000,
    maxTotalTasks: 100, maxTasksPerRequest: 3, datadome: true}, projects: {}};
  const posts = [];
  let clock = 0;
  const answers = {
    TurnstileTaskProxyless: {token: 'x'.repeat(50)},
    DataDomeSliderTask: {cookie: 'datadome=' + 'c'.repeat(40) + '; Path=/; Secure'},
    GridTask: {click: [2, 5]},
  };
  const fetchImpl = async (url, {body}) => {
    const data = JSON.parse(body);
    posts.push(data);
    const value = url.endsWith('createTask') ? {errorId: 0, taskId: posts.length, type: data.task.type}
      : {errorId: 0, status: 'ready', cost: '0.00145', solution: answers[posts.find(p => p.task)?.task?.type ?? 'GridTask']};
    if (url.endsWith('getTaskResult')) value.solution = answers[posts.filter(p => p.task).at(-1).task.type];
    return {ok: true, body: [Buffer.from(JSON.stringify(value))]};
  };
  const solver = new CaptchaSolver(store, config, {fetchImpl, wait: async () => { clock += 5000; }, now: () => clock});
  const request = randomUUID();
  const base = {request, project: PROJECT, websiteURL: 'https://shop.example.com/p?secret=1', userAgent: 'Mozilla/5.0'};
  assert.equal((await solver.solve('turnstile', {...base, siteKey: '0x4AAAAAAAsyntheticKey'})).token.length, 50);
  const dd = await solver.solve('datadome', {...base, captchaUrl: 'https://geo.captcha-delivery.com/captcha/?t=fe&cid=1',
    proxyUrl: 'http://user:pa%3Ass@core-residential.evomi.com:1000/'});
  assert.match(dd.cookie, /^datadome=/);
  const ddTask = posts.filter(p => p.task).at(-1).task;
  assert.deepEqual([ddTask.proxyAddress, ddTask.proxyPort, ddTask.proxyLogin, ddTask.proxyPassword], ['core-residential.evomi.com', '1000', 'user', 'pa:ss']);
  // Daily budget: 2 x 1450 used, + 3000 reserved would pass 7000? 2900 + 3000 = 5900 fits; a fourth is over the per-request cap.
  assert.deepEqual((await solver.solve('grid', {...base, image: 'aW1hZ2U=', instructions: 'Click the bicycles'})).click, [2, 5]);
  await assert.rejects(solver.solve('turnstile', {...base, siteKey: '0x4AAAAAAAsyntheticKey'}), {code: 'captcha_budget_exhausted'});
  await assert.rejects(solver.solve('datadome', {...base, request: randomUUID(), captchaUrl: 'https://geo.captcha-delivery.com/captcha/?t=bv',
    proxyUrl: 'http://u:p@proxy.example.com:1/'}), {code: 'captcha_ip_banned'});
  const rows = (await store.pool.query('SELECT * FROM captcha_solves WHERE request = $1', [request])).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.host === 'shop.example.com'));
  assert.ok(!JSON.stringify(rows).includes('xxxxxxxxxx') && !JSON.stringify(rows).includes('secret'), 'no token or URL path stored');
  assert.equal(new CaptchaSolver(store, {captcha: {...config.captcha, datadome: false}}).supports('datadome'), false);
  assert.equal(captchaSettings({captcha: {enabled: false}}), null);
});
