import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {databaseUrl, openStore, PROJECT} from './helpers.mjs';
import {Ledger, prices, priceOf, worstCaseOf} from '../src/billing/ledger.mjs';
import {Purchases, packCredits} from '../src/billing/purchases.mjs';

const skip = !databaseUrl;

test('prices come from config and charge by the step that succeeded', () => {
  const table = prices({pricing: {browser: 12}});
  assert.equal(table.browser, 12);
  assert.equal(table.http, 1);
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
  await store.tx(async c => { await ledger.lock(c, PROJECT); await ledger.hold(c, {project: PROJECT, request, credits: 60}); });
  assert.equal((await ledger.balance(PROJECT)).available, 9_940);
  assert.equal(await store.tx(c => ledger.charge(c, {project: PROJECT, request, step: 'browser', credits: 99, captcha: true})), 60,
    'never more than the reservation');
  assert.equal((await ledger.balance(PROJECT)).credits, 9_940);
  const failed = randomUUID();
  await store.tx(c => ledger.hold(c, {project: PROJECT, request: failed, credits: 25}));
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
  assert.equal((await ledger.balance(PROJECT)).held, true);
  await store.tx(c => purchases.setPaymentHold(c, {project: PROJECT, mode: 'live', accountId: 'acct_test', holdId: 'dispute:dp_1', active: false}));
  assert.equal((await ledger.balance(PROJECT)).held, false);
  await assert.rejects(store.tx(c => ledger.hold(c, {project: PROJECT, request: randomUUID(), credits: 0})), {code: 'invalid_request'});
});
