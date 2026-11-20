// The platform side of a fetch: reservation, allowed_steps, settlement once per
// job, events, the reconciler and customer webhooks, against an in-memory engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {databaseUrl, openStore, platformFor, testConfig, PROJECT, UNMETERED_TOKEN, EVENT_KEY} from './helpers.mjs';
import {Ledger} from '../src/billing/ledger.mjs';
import {verifyEvent} from '../src/engine/events.mjs';

const skip = !databaseUrl;
const balance = async store => (await new Ledger({store, config: {}}).balance(PROJECT)).available;
const reservations = async store => (await store.pool.query('SELECT count(*)::int AS n FROM credit_reservations')).rows[0].n;
const settlement = async (store, id) => (await store.pool.query('SELECT * FROM fetch_settlements WHERE request = $1', [id])).rows[0];

test('a successful fetch is charged once, at the price of the step the engine reports', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, engine} = await platformFor(store, {script: () => ({step: 'http'})});
  const first = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/p/1', formats: ['markdown'], idempotency_key: 'one'}});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, 'succeeded');
  assert.deepEqual(first.body.credits, {charged: 1, max: 100});
  assert.deepEqual(Object.keys(first.body), ['id', 'status', 'idempotency_key', 'url', 'created_at', 'finished_at', 'tags', 'data', 'credits',
    'attempts', 'skipped', 'fixes', 'error']);
  assert.equal(await balance(store), 99);
  assert.equal(await reservations(store), 0);
  // What the engine was sent: the job id, the project as tenant, every tier the reservation covers.
  const sent = engine.jobs.get(first.body.id);
  assert.equal(sent.tenant, PROJECT);
  assert.equal(sent.request.url, 'https://shop.example.com/p/1');
  // Replay: the same job, no new work, no new charge.
  const replay = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/p/1', formats: ['markdown'], idempotency_key: 'one'}});
  assert.equal(replay.body.id, first.body.id);
  assert.deepEqual(replay.body.credits, {charged: 1, max: 100});
  assert.equal(engine.jobs.size, 1);
  assert.equal(await balance(store), 99);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM fetch_settlements')).rows[0].n, 1, 'the replay left nothing behind');
  const conflict = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/p/2', idempotency_key: 'one'}});
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
  assert.equal(await reservations(store), 0, 'a refused job releases its reservation');
  // Read back, list, content, delete: the engine's job with the platform's credits.
  const read = await call('GET', `/v1/fetch/${first.body.id}`);
  assert.equal(read.body.credits.charged, 1);
  assert.match(read.body.data.body, /ok/);
  assert.equal((await call('GET', `/v1/fetch/${first.body.id}?include_body=false`)).body.data.body, undefined);
  const list = await call('GET', '/v1/fetch?limit=10');
  assert.deepEqual(list.body.items.map(i => [i.id, i.credits.charged]), [[first.body.id, 1]]);
  assert.match((await call('GET', `/v1/fetch/${first.body.id}/content`)).raw.toString(), /ok/);
  assert.equal((await call('GET', `/v1/fetch/${first.body.id}/screenshot`)).status, 404);
  assert.equal((await call('DELETE', `/v1/fetch/${first.body.id}`)).status, 204);
  assert.equal((await call('GET', `/v1/fetch/${first.body.id}`)).body.data.content_expired, true);
  assert.equal((await call('GET', `/v1/fetch/${first.body.id}/content`)).status, 410);
  assert.equal((await call('GET', '/v1/fetch/00000000-0000-4000-8000-000000000000')).status, 404);
  const usage = await call('GET', '/v1/usage');
  assert.equal(usage.body.balance.credits, 99);
  assert.equal(usage.body.used.credits, 1);
  assert.equal(usage.body.used.succeeded, 1);
  assert.deepEqual(usage.body.by_step, [{step: 'http', requests: 1, credits: 1}]);
});

test('prices come from the platform: residential, browser, captcha and bandwidth overage', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const outcomes = [{step: 'http_residential'}, {step: 'browser_residential', captcha: true}, {step: 'http_residential', wire_bytes: 2_500_001}];
  const {call} = await platformFor(store, {script: () => outcomes.shift()});
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://a.example.com/'}})).body.credits.charged, 5);
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://b.example.com/'}})).body.credits.charged, 35, 'residential browser 25 + captcha 10');
  // 60 left: the reservation (and so the charge) is capped at what is available.
  const big = await call('POST', '/v1/fetch', {body: {url: 'https://c.example.com/'}});
  assert.deepEqual(big.body.credits, {charged: 15, max: 60}, '5 + 2 MB over the included 1 MB at 5 each');
  assert.equal(await balance(store), 45);
});

test('failures are free; the reservation shapes allowed_steps and refusals say why', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, engine} = await platformFor(store, {script: request => (request.url.includes('wall') ? {status: 'failed'}
    : request.render === 'always' ? {planned: ['browser', 'browser_residential']} : {})});
  const failed = await call('POST', '/v1/fetch', {body: {url: 'https://wall.example.com/'}});
  assert.equal(failed.body.status, 'failed');
  assert.deepEqual(failed.body.credits, {charged: 0, max: 100});
  assert.equal(await balance(store), 100);
  assert.equal(await reservations(store), 0);
  // max_credits below every planned step.
  const low = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/', render: 'always', max_credits: 5}});
  assert.equal(low.status, 402);
  assert.equal(low.body.error.code, 'max_credits_too_low');
  assert.equal(low.body.error.details.min_credits, 10);
  // The tiers sent are the ones the reservation can pay for.
  const capped = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/x', max_credits: 7, idempotency_key: 'capped'}});
  assert.equal(capped.body.credits.max, 7);
  assert.deepEqual(engine.jobs.get(capped.body.id).allowed, ['http', 'http_residential']);
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/', max_credits: 0}})).body.error.details.field, 'max_credits');
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/', max_credits: 100_001}})).status, 400);
  // No balance: insufficient_credits, and nothing is left reserved.
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 0 WHERE project = $1', [PROJECT]);
  const broke = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/new'}});
  assert.equal(broke.status, 402);
  assert.equal(broke.body.error.code, 'insufficient_credits');
  assert.deepEqual(broke.body.error.details, {available: 0, needed: 1});
  // ... but a replay of a finished job still answers with its result.
  const replay = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/x', max_credits: 7, idempotency_key: 'capped'}});
  assert.equal(replay.status, 200, 'replays are not refused for credits');
  assert.equal(await reservations(store), 0);
  // A payment hold stops new spending.
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 100 WHERE project = $1', [PROJECT]);
  await store.pool.query(`INSERT INTO paid_credit_payment_holds (project, mode, account_id, hold_id) VALUES ($1, 'live', 'acct_test', 'dispute:1')`, [PROJECT]);
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/held'}})).body.error.code, 'payment_hold');
  await store.pool.query('DELETE FROM paid_credit_payment_holds');
  // Unmetered projects (provisioned in config) send every tier and pay nothing.
  const free = await call('POST', '/v1/fetch', {token: UNMETERED_TOKEN, body: {url: 'https://shop.example.com/', render: 'always'}});
  assert.equal(free.body.status, 'succeeded');
  assert.deepEqual(free.body.credits, {charged: 0, max: null});
  assert.equal((await call('POST', '/v1/fetch', {token: 'wrong', body: {url: 'https://shop.example.com/'}})).status, 401);
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://10.0.0.1/'}})).body.error.code, 'url_not_allowed');
  assert.equal(await reservations(store), 0);
  assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM fetch_settlements WHERE status = 'pending'`)).rows[0].n, 0);
});

test('a next page is a new request: reserved, charged only when it succeeds, refused for free', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pages = new Map();
  // Page 1 links to page 2; page 2 has a Load more button; the click on it fails.
  const {call, engine} = await platformFor(store, {script: (request, {previous} = {}) => {
    if (request.url.includes('/slow')) return {hold: gate};
    if (request.url.includes('/single')) return {step: 'http'};
    if (previous && previous === pages.get(2)) return {status: 'failed', planned: ['browser']};
    return {planned: ['browser', 'browser_residential'], step: 'browser',
      next_page: request.url.endsWith('page=2') ? {how: 'click'} : {how: 'link', url: 'https://shop.example.com/list?page=2'}};
  }});
  const first = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/list', formats: ['markdown'], tags: ['crawl']}});
  assert.equal(first.body.status, 'succeeded');
  assert.deepEqual(first.body.data.page, {number: 1, previous_id: null, screens: 0, end: null});
  assert.deepEqual(first.body.data.next_page, {how: 'link', url: 'https://shop.example.com/list?page=2'});
  assert.equal(await balance(store), 90);

  // The next page: a new request with its own id, billed at its own step.
  const second = await call('POST', `/v1/fetch/${first.body.id}/next`, {body: {idempotency_key: 'page-2'}});
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.notEqual(second.body.id, first.body.id);
  assert.equal(second.body.url, 'https://shop.example.com/list?page=2');
  assert.deepEqual(second.body.data.page, {number: 2, previous_id: first.body.id, screens: 0, end: null});
  assert.deepEqual(second.body.tags, ['crawl'], 'settings come from the earlier request');
  assert.deepEqual(second.body.credits, {charged: 10, max: 90});
  assert.equal(await balance(store), 80);
  pages.set(2, second.body.id);
  assert.ok(engine.calls.some(c => c.method === 'POST' && c.url === `/internal/v1/jobs/${first.body.id}/next`));
  assert.deepEqual(engine.jobs.get(second.body.id).allowed, ['http', 'http_residential', 'browser', 'browser_residential']);
  // Replaying the key returns the same page and charges nothing more; another body under it is refused.
  const again = await call('POST', `/v1/fetch/${first.body.id}/next`, {body: {idempotency_key: 'page-2'}});
  assert.equal(again.body.id, second.body.id);
  assert.equal(await balance(store), 80);
  assert.equal((await call('POST', `/v1/fetch/${first.body.id}/next`, {body: {idempotency_key: 'page-2', scroll: 3}})).body.error.code,
    'idempotency_conflict');

  // A next page that fails costs nothing, and has no next page of its own.
  const third = await call('POST', `/v1/fetch/${second.body.id}/next`);
  assert.equal(third.status, 200, JSON.stringify(third.body));
  assert.equal(third.body.status, 'failed');
  assert.equal(third.body.credits.charged, 0);
  assert.equal(await balance(store), 80);
  const afterFailed = await call('POST', `/v1/fetch/${third.body.id}/next`, {body: {}});
  assert.equal(afterFailed.status, 409);
  assert.deepEqual([afterFailed.body.error.code, afterFailed.body.error.details], ['no_next_page', {reason: 'failed'}]);

  // Refusals are 4xx, free, and leave nothing reserved.
  const single = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/single'}});
  assert.equal(single.body.data.next_page, null);
  const none = await call('POST', `/v1/fetch/${single.body.id}/next`, {body: {}});
  assert.deepEqual([none.status, none.body.error.details], [409, {reason: 'none_found'}]);
  assert.equal((await call('POST', '/v1/fetch/00000000-0000-4000-8000-000000000000/next', {body: {}})).status, 404);
  const field = await call('POST', `/v1/fetch/${first.body.id}/next`, {body: {url: 'https://shop.example.com/other'}});
  assert.deepEqual([field.status, field.body.error.details.field], [400, 'url']);
  const low = await call('POST', `/v1/fetch/${first.body.id}/next`, {body: {max_credits: 5}});
  assert.deepEqual([low.status, low.body.error.code, low.body.error.details.min_credits], [402, 'max_credits_too_low', 10]);
  const slow = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/slow', async: true}});
  const running = await call('POST', `/v1/fetch/${slow.body.id}/next`, {body: {}});
  assert.deepEqual([running.status, running.body.error.code], [409, 'pending']);
  release();
  await engine.jobs.get(slow.body.id).done;
  await call('GET', `/v1/fetch/${slow.body.id}`);
  assert.equal((await call('DELETE', `/v1/fetch/${second.body.id}`)).status, 204);
  const expired = await call('POST', `/v1/fetch/${second.body.id}/next`, {body: {idempotency_key: 'page-3-again'}});
  assert.deepEqual([expired.status, expired.body.error.code], [410, 'content_expired']);
  // Another project never reaches this project's requests.
  assert.equal((await call('POST', `/v1/fetch/${first.body.id}/next`, {token: UNMETERED_TOKEN, body: {}})).status, 404);
  assert.equal(await reservations(store), 0);
  assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM fetch_settlements WHERE status = 'pending'`)).rows[0].n, 0);
  const usage = await call('GET', '/v1/usage');
  assert.equal(usage.body.used.credits, 22, 'page 1 and page 2 at the browser price, two plain pages at 1: 10 + 10 + 1 + 1');
});

test('a project with too many jobs running is told to wait', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {call, engine} = await platformFor(store, {config: testConfig({fetchLimits: {maxConcurrentPerProject: 2}}), script: () => ({hold: gate})});
  const job = n => ({url: `https://slow.example.com/${n}`, async: true, max_credits: 1});
  for (const n of [1, 2]) assert.equal((await call('POST', '/v1/fetch', {body: job(n)})).status, 202);
  const busy = await call('POST', '/v1/fetch', {body: job(3)});
  assert.equal(busy.status, 429);
  assert.equal(busy.body.error.code, 'too_many_requests');
  assert.equal(busy.headers['retry-after'], '5');
  release();
  await Promise.all([...engine.jobs.values()].map(job => job.done));
});

test('async jobs settle from the engine\'s signed event, once, and webhooks follow', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {call, engine, events, platform, webhooks} = await platformFor(store, {script: () => ({step: 'browser', hold: gate})});
  const pending = await call('POST', '/v1/fetch', {body: {url: 'https://slow.example.com/', async: true, webhook_url: 'https://hooks.example.com/fx'}});
  assert.equal(pending.status, 202);
  assert.deepEqual(pending.body.credits, {charged: 0, max: 100});
  assert.equal(await balance(store), 0, 'the whole worst case is held while it runs');
  release();
  await engine.jobs.get(pending.body.id).done;
  // A bad signature, an old timestamp or another tenant settles nothing.
  assert.equal((await engine.deliver(events, {tamper: true}))[0].status, 401);
  engine.outbox.push(pending.body.id);
  assert.equal((await engine.deliver(events, {key: 'x'.repeat(40)}))[0].status, 401);
  assert.equal((await settlement(store, pending.body.id)).status, 'pending');
  engine.outbox.push(pending.body.id);
  const [delivered] = await engine.deliver(events);
  assert.deepEqual(delivered, {status: 200, body: {settled: pending.body.id}});
  assert.equal((await settlement(store, pending.body.id)).credits_charged, '10');
  assert.equal(await balance(store), 90);
  // The engine retries until it hears 200; a repeat changes nothing.
  engine.outbox.push(pending.body.id);
  await engine.deliver(events);
  assert.equal(await balance(store), 90);
  await platform.webhooks.kick();
  assert.equal(webhooks.length, 1);
  const hook = webhooks[0];
  assert.equal(hook.url, 'https://hooks.example.com/fx');
  assert.equal(hook.payload.id, pending.body.id);
  assert.equal(hook.payload.credits.charged, 10);
  assert.equal(hook.payload.data.body, undefined, 'the body is never sent to a webhook');
  const secret = await platform.front.webhookSecret(PROJECT);
  assert.equal(hook.headers['x-fetchx-signature'],
    'sha256=' + createHmac('sha256', secret).update(`${hook.headers['x-fetchx-timestamp']}.`).update(hook.body).digest('hex'));
  // An event for a job the platform does not know is acknowledged and ignored.
  engine.jobs.set('00000000-0000-4000-8000-0000000000ff', {...engine.jobs.get(pending.body.id), id: '00000000-0000-4000-8000-0000000000ff'});
  engine.outbox.push('00000000-0000-4000-8000-0000000000ff');
  assert.deepEqual((await engine.deliver(events))[0].body, {unknown: true});
  // Signatures: the timestamp window and the previous key during a rotation.
  const body = Buffer.from('{}');
  const sign = (key, ts) => ({'x-fetchx-timestamp': String(ts), 'x-fetchx-signature': 'sha256=' + createHmac('sha256', key).update(`${ts}.`).update(body).digest('hex')});
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyEvent([EVENT_KEY], sign(EVENT_KEY, now), body), true);
  assert.equal(verifyEvent([EVENT_KEY], sign(EVENT_KEY, now - 301), body), false);
  assert.equal(verifyEvent(['new-key-0123456789abcdef0123456789', EVENT_KEY], sign(EVENT_KEY, now), body), true);
});

test('a finished job is settled when it is read, even before its event arrives', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {call, engine} = await platformFor(store, {script: () => ({hold: gate})});
  const pending = await call('POST', '/v1/fetch', {body: {url: 'https://slow.example.com/', async: true}});
  release();
  await engine.jobs.get(pending.body.id).done;
  const read = await call('GET', `/v1/fetch/${pending.body.id}`);
  assert.equal(read.body.status, 'succeeded');
  assert.equal(read.body.credits.charged, 1);
  assert.equal(await balance(store), 99);
});

test('the reconciler settles jobs whose event was lost and releases jobs the engine never started', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {call, engine, platform} = await platformFor(store, {script: () => ({hold: gate, step: 'http_residential'})});
  const lost = await call('POST', '/v1/fetch', {body: {url: 'https://slow.example.com/', async: true}});
  release();
  await engine.jobs.get(lost.body.id).done;
  // A submission whose answer never came back (the engine never saw it).
  await store.pool.query(`INSERT INTO fetch_settlements (request, project, credits_max, deadline) VALUES
    ('00000000-0000-4000-8000-0000000000bb', $1, 20, now() + interval '5 minutes')`, [PROJECT]);
  await store.pool.query(`INSERT INTO credit_reservations (request, project, credits) VALUES ('00000000-0000-4000-8000-0000000000bb', $1, 20)`, [PROJECT]);
  assert.equal(await platform.front.reconcile(), 0, 'nothing is past its deadline yet');
  await store.pool.query(`UPDATE fetch_settlements SET deadline = now() - interval '5 minutes'`);
  assert.equal(await platform.front.reconcile(), 2);
  assert.equal((await settlement(store, lost.body.id)).credits_charged, '5');
  assert.equal(await settlement(store, '00000000-0000-4000-8000-0000000000bb'), undefined);
  assert.equal(await reservations(store), 0);
  assert.equal(await balance(store), 95);
});

test('when the engine cannot be reached nothing is charged; an answer that may have been lost waits for the reconciler', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let failure = Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}});
  const {call, engine} = await platformFor(store, {deps: {engineFetch: async (...args) => {
    if (failure) throw failure;
    return engine.fetchImpl(...args);
  }}});
  const down = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/'}});
  assert.equal(down.status, 503);
  assert.equal(down.body.error.code, 'unavailable');
  assert.equal(await reservations(store), 0, 'never sent: released at once');
  failure = Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNRESET'}});
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/'}})).status, 503);
  assert.equal(await reservations(store), 1, 'maybe sent: held until the reconciler knows');
  assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM fetch_settlements WHERE status = 'pending'`)).rows[0].n, 1);
  failure = null;
});

test('webhooks are tried 3 times, then given up; private addresses are never posted to', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, platform, webhooks} = await platformFor(store, {webhookAnswer: () => 500});
  const done = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/', webhook_url: 'https://hooks.example.com/fx'}});
  assert.equal(done.body.status, 'succeeded');
  for (let i = 0; i < 3; i++) {
    await platform.webhooks.kick();
    await store.pool.query('UPDATE webhook_deliveries SET next_attempt_at = now()');
  }
  await platform.webhooks.kick();
  assert.equal(webhooks.length, 3);
  const row = (await store.pool.query('SELECT attempts, last_error, gave_up_at FROM webhook_deliveries')).rows[0];
  assert.equal(row.attempts, 3);
  assert.equal(row.last_error, 'http_500');
  assert.ok(row.gave_up_at);
  // A name that now resolves to a private address is refused without a post.
  const rebind = await platformFor(store, {deps: {webhookResolve: async () => [{address: '10.0.0.5', family: 4}]}});
  await rebind.call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/2', webhook_url: 'https://rebind.example.com/fx'}});
  await rebind.platform.webhooks.kick();
  assert.equal(rebind.webhooks.length, 0);
  assert.equal((await store.pool.query(`SELECT last_error FROM webhook_deliveries WHERE gave_up_at IS NOT NULL AND attempts = 1`)).rows[0].last_error,
    'url_not_allowed');
  assert.match(await platform.front.webhookSecret(PROJECT), /^whsec_/);
  const rotated = await platform.front.webhookSecret(PROJECT, {rotate: true});
  assert.equal(await platform.front.webhookSecret(PROJECT), rotated);
});
