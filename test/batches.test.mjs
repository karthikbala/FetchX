// Batches (src/fetch/batches.mjs): many URLs in one job, checked before they
// are queued, started at each host's pace, billed per item only on success,
// reported by webhook and by page; pausing for credits, canceling, and the
// recovery paths (a paced start refused, an uncertain start, an orphan).
import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseUrl, openStore, platformFor, testConfig, PROJECT, UNMETERED_TOKEN} from './helpers.mjs';
import {Ledger} from '../src/billing/ledger.mjs';

const skip = !databaseUrl;
const balance = async store => (await new Ledger({store, config: {}}).balance(PROJECT)).available;
const reservations = async store => (await store.pool.query('SELECT count(*)::int AS n FROM credit_reservations')).rows[0].n;
const HOOK = 'https://hooks.example.com/fetchx';

// Delivers every due webhook through the sender's own run (settlements kick it
// in the background; a second, concurrent delivery would post twice).
async function deliverHooks(platform) {
  while (platform.webhooks.running) await platform.webhooks.running;
  await platform.webhooks.kick();
  while (platform.webhooks.running) await platform.webhooks.running;
}

// Runs the queue until nothing more starts: each round starts what fits,
// lets the started jobs finish, and delivers their events (which settles them).
async function drain({platform, engine, events}, {rounds = 20} = {}) {
  for (let round = 0; round < rounds; round++) {
    const {started} = await platform.batchRunner.tick();
    await Promise.all([...engine.jobs.values()].map(job => job.done));
    const finished = engine.outbox.length;
    await engine.deliver(events);
    if (!started && !finished) return round;
  }
  throw new Error('the queue did not drain');
}

test('a batch runs every item at its host\'s pace, bills only successes, and reports each result and its end', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const ctx = await platformFor(store, {
    script: request => request.url.includes('/wall') ? {status: 'failed'} : {step: 'http'},
    pace: host => host === 'slow.example.com' ? {tier: 'guarded', max_running: 1, start_gap_ms: 0} : {tier: 'open', max_running: 4, start_gap_ms: 0},
  });
  const {call, engine, webhooks, platform} = ctx;
  // Each item reserves its worst case (160 credits) while it runs.
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 1000 WHERE project = $1', [PROJECT]);
  const submitted = await call('POST', '/v1/batches', {body: {
    items: ['https://slow.example.com/1', 'https://slow.example.com/2', {url: 'https://slow.example.com/3', tags: ['three']},
      'https://fast.example.com/a', {url: 'https://fast.example.com/wall', formats: ['text']}],
    defaults: {formats: ['markdown'], tags: ['all']}, webhook_url: HOOK, idempotency_key: 'crawl-1', tags: ['nightly']}});
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  const batch = submitted.body;
  assert.deepEqual({status: batch.status, items: batch.items, credits: batch.credits, webhook: batch.webhook, tags: batch.tags},
    {status: 'running', items: {total: 5, queued: 5, running: 0, succeeded: 0, failed: 0, canceled: 0}, credits: {charged: 0}, webhook: true,
      tags: ['nightly']});
  assert.equal(engine.calls.filter(c => c.url === '/internal/v1/requests/check').length, 1, 'checked in one call');
  assert.equal(engine.jobs.size, 0, 'nothing starts at submit');
  // The same key and body is the same batch; another body is refused.
  const again = await call('POST', '/v1/batches', {body: {
    items: ['https://slow.example.com/1', 'https://slow.example.com/2', {url: 'https://slow.example.com/3', tags: ['three']},
      'https://fast.example.com/a', {url: 'https://fast.example.com/wall', formats: ['text']}],
    defaults: {formats: ['markdown'], tags: ['all']}, webhook_url: HOOK, idempotency_key: 'crawl-1', tags: ['nightly']}});
  assert.equal(again.status, 200);
  assert.equal(again.body.id, batch.id);
  assert.equal((await call('POST', '/v1/batches', {body: {items: ['https://slow.example.com/1'], idempotency_key: 'crawl-1'}})).body.error.code,
    'idempotency_conflict');

  // First tick: one item on the guarded host (1 at once), both on the open host.
  const first = await platform.batchRunner.tick();
  assert.equal(first.started, 3);
  const running = (await call('GET', `/v1/batches/${batch.id}`)).body;
  assert.equal(running.items.running + running.items.succeeded + running.items.failed, 3);
  const jobs = [...engine.jobs.values()];
  assert.equal(jobs.filter(job => job.request.url.startsWith('https://slow.')).length, 1);
  for (const job of jobs) {
    assert.equal(job.request.async, true);
    assert.match(job.key, new RegExp(`^batch\\.${batch.id}\\.\\d$`), 'each item has its own key');
    assert.equal(job.request.webhook_url, undefined, 'the platform delivers batch webhooks itself');
  }
  // Items are the defaults with their own fields on top.
  const three = (await drain(ctx), [...engine.jobs.values()].find(job => job.request.url.endsWith('/3')));
  assert.deepEqual(three.request.tags, ['three']);
  assert.deepEqual(three.request.formats, ['markdown']);
  assert.deepEqual([...engine.jobs.values()].find(job => job.request.url.endsWith('/wall')).request.formats, ['text']);

  const done = (await call('GET', `/v1/batches/${batch.id}`)).body;
  assert.equal(done.status, 'finished');
  assert.ok(done.finished_at);
  assert.deepEqual(done.items, {total: 5, queued: 0, running: 0, succeeded: 4, failed: 1, canceled: 0});
  assert.deepEqual(done.credits, {charged: 4}, 'four successes at 1 credit; the failure is free');
  assert.equal(await balance(store), 996);
  assert.equal(await reservations(store), 0);

  // Webhooks: every item's result as it finished, then the batch.
  await deliverHooks(platform);
  const events = webhooks.map(hook => hook.headers['x-fetchx-event']);
  assert.deepEqual(events.filter(event => event === 'fetch.finished').length, 5);
  assert.equal(events.at(-1), 'batch.finished');
  const itemHook = webhooks.find(hook => hook.payload.url === 'https://fast.example.com/a').payload;
  assert.deepEqual(itemHook.batch, {id: batch.id, index: 3});
  assert.equal(itemHook.data.body, undefined, 'without the body');
  assert.equal(webhooks.at(-1).payload.status, 'finished');
  assert.ok(webhooks.every(hook => hook.url === HOOK && /^sha256=/.test(hook.headers['x-fetchx-signature'])));

  // Results by page: by index, with each result; and the feed by finish order.
  const page = (await call('GET', `/v1/batches/${batch.id}/items?limit=2`)).body;
  assert.deepEqual(page.items.map(item => [item.index, item.url, item.status]), [[0, 'https://slow.example.com/1', 'succeeded'],
    [1, 'https://slow.example.com/2', 'succeeded']]);
  assert.equal(page.items[0].result.status, 'succeeded');
  assert.deepEqual(page.items[0].result.batch, {id: batch.id, index: 0});
  assert.equal(page.items[0].result.data.body, undefined);
  assert.equal(typeof page.items[0].result.data.markdown, 'string');
  assert.equal(page.items[0].credits.charged, 1);
  const rest = (await call('GET', `/v1/batches/${batch.id}/items?limit=10&cursor=${page.next_cursor}`)).body;
  assert.deepEqual(rest.items.map(item => item.index), [2, 3, 4]);
  assert.equal(rest.next_cursor, null);
  const failed = (await call('GET', `/v1/batches/${batch.id}/items?status=failed&results=false`)).body.items;
  assert.deepEqual(failed.map(item => [item.index, item.result, item.error]), [[4, null, null]]);
  const feed = (await call('GET', `/v1/batches/${batch.id}/items?order=finished&limit=3`)).body;
  assert.equal(feed.items.length, 3);
  const feedRest = (await call('GET', `/v1/batches/${batch.id}/items?order=finished&limit=3&cursor=${feed.next_cursor}`)).body;
  assert.equal(feedRest.items.length, 2);
  assert.equal(feedRest.next_cursor, null, 'the batch is over and all was read');
  assert.deepEqual(new Set([...feed.items, ...feedRest.items].map(item => item.index)), new Set([0, 1, 2, 3, 4]));
  // Each item is a request of its own, which says which batch it belongs to.
  const one = (await call('GET', `/v1/fetch/${page.items[1].request_id}`)).body;
  assert.deepEqual(one.batch, {id: batch.id, index: 1});
  // The list, and reads by other projects.
  assert.deepEqual((await call('GET', '/v1/batches')).body.items.map(item => item.id), [batch.id]);
  assert.equal((await call('GET', `/v1/batches/${batch.id}`, {token: UNMETERED_TOKEN})).status, 404);
  assert.equal((await call('GET', '/v1/batches/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await call('GET', `/v1/batches/${batch.id}/items?order=random`)).status, 400);
  // A batch item's key cannot be used by a single request.
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://fast.example.com/a', idempotency_key: `batch.${batch.id}.3`}})).status, 400);
});

test('a batch is checked whole before anything is queued, and refusals name the item', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, engine} = await platformFor(store);
  const refused = async (body, code, field) => {
    const answer = await call('POST', '/v1/batches', {body});
    assert.equal(answer.body.error?.code, code, JSON.stringify(answer.body));
    if (field) assert.equal(answer.body.error.details.field, field);
    return answer;
  };
  await refused({items: []}, 'invalid_request', 'items');
  await refused({items: Array.from({length: 1001}, (_, i) => `https://a.example.com/${i}`)}, 'invalid_request', 'items');
  await refused({items: ['https://a.example.com/', 42]}, 'invalid_request', 'items[1]');
  await refused({items: [{url: 'https://a.example.com/', async: true}]}, 'invalid_request', 'items[0].async');
  await refused({items: ['https://a.example.com/'], defaults: {url: 'https://b.example.com/'}}, 'invalid_request', 'defaults.url');
  await refused({items: ['https://a.example.com/'], defaults: {webhook_url: HOOK}}, 'invalid_request', 'defaults.webhook_url');
  await refused({items: ['https://a.example.com/'], webhook_url: 'http://hooks.example.com/'}, 'invalid_request', 'webhook_url');
  await refused({items: ['https://a.example.com/'], extra: 1}, 'invalid_request', 'extra');
  // The engine's checks, told with the item's place: its own field, or the default's.
  await refused({items: ['https://a.example.com/', {url: 'https://a.example.com/x', formats: ['pdf']}]}, 'invalid_request', 'items[1].formats');
  await refused({items: ['https://a.example.com/', 'https://a.example.com/y'], defaults: {formats: ['pdf']}}, 'invalid_request', 'defaults.formats');
  const local = await refused({items: ['https://a.example.com/', 'http://127.0.0.1/']}, 'url_not_allowed', 'items[1].url');
  assert.equal(local.status, 400);
  // The platform's own check (what it bills from).
  await refused({items: [{url: 'https://a.example.com/', max_credits: 0}]}, 'invalid_request', 'items[0].max_credits');
  await refused({items: ['https://a.example.com/'], defaults: {max_credits: 100_001}}, 'invalid_request', 'defaults.max_credits');
  // No credits: refused before the engine is asked anything.
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 0 WHERE project = $1', [PROJECT]);
  const broke = await refused({items: ['https://a.example.com/']}, 'insufficient_credits');
  assert.equal(broke.status, 402);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM fetch_batches')).rows[0].n, 0, 'nothing was queued');
  assert.equal(engine.jobs.size, 0);
  // Unmetered projects are not credit-checked.
  assert.equal((await call('POST', '/v1/batches', {token: UNMETERED_TOKEN, body: {items: ['https://a.example.com/']}})).status, 202);
});

test('the queue never takes a project\'s last running slot, stops while browsers are backed up, and keeps to the host\'s pace', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const config = testConfig();
  config.projects[PROJECT].maxConcurrentRequests = 3;
  const ctx = await platformFor(store, {config, script: () => ({step: 'http', hold}),
    pace: host => host === 'one.example.com' ? {max_running: 1, start_gap_ms: 0} : {max_running: 8, start_gap_ms: 0}});
  const {call, engine, platform} = ctx;
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 1000 WHERE project = $1', [PROJECT]);
  const items = [...Array.from({length: 4}, (_, i) => `https://one.example.com/${i}`), ...Array.from({length: 4}, (_, i) => `https://many.example.com/${i}`)];
  const {body: batch} = await call('POST', '/v1/batches', {body: {items}});
  engine.fake.browserWaiting = 2;
  assert.deepEqual(await platform.batchRunner.tick(), {started: 0, browser_waiting: 2}, 'nothing joins a browser queue');
  engine.fake.browserWaiting = 0;
  assert.equal((await platform.batchRunner.tick()).started, 2, 'a limit of 3 at once leaves one slot for single requests');
  assert.equal((await platform.batchRunner.tick()).started, 0);
  const running = [...engine.jobs.values()];
  assert.equal(running.filter(job => job.request.url.startsWith('https://one.')).length, 1, 'one at a time on the guarded host');
  // A single request still gets the slot that was kept.
  const single = await call('POST', '/v1/fetch', {body: {url: 'https://other.example.com/', async: true}});
  assert.equal(single.status, 202);
  release();
  await drain(ctx);
  const done = (await call('GET', `/v1/batches/${batch.id}`)).body;
  assert.deepEqual(done.items, {total: 8, queued: 0, running: 0, succeeded: 8, failed: 0, canceled: 0});
  assert.equal(done.status, 'finished');
});

test('a host with spaced starts is looked at again when its next start is due, not at the next round', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const ctx = await platformFor(store, {script: () => ({step: 'http', hold}), pace: () => ({max_running: 4, start_gap_ms: 300}),
    deps: {batchIntervalMs: 60_000}});
  const {call, engine, platform} = ctx;
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 1000 WHERE project = $1', [PROJECT]);
  const {body: batch} = await call('POST', '/v1/batches', {body: {items: [1, 2, 3].map(i => `https://gap.example.com/${i}`)}});
  assert.deepEqual(await platform.batchRunner.tick(), {started: 1, next_in_ms: 300}, 'one start, the next due after the gap');
  const early = await platform.batchRunner.tick();
  assert.equal(early.started, 0);
  assert.ok(early.next_in_ms > 0 && early.next_in_ms <= 300, 'still inside the gap');
  // Running, the queue wakes itself for each due start, long before its 60 s round.
  const begun = Date.now();
  platform.batchRunner.start();
  for (let i = 0; i < 150 && engine.jobs.size < 3; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(engine.jobs.size, 3);
  assert.ok(Date.now() - begun < 2_000);
  await platform.batchRunner.close();
  const starts = (await store.pool.query('SELECT started_at FROM fetch_batch_items WHERE batch = $1 ORDER BY started_at', [batch.id])).rows
    .map(row => row.started_at.getTime());
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 290, `starts ${starts[i] - starts[i - 1]} ms apart`);
  release();
  await drain(ctx);
  assert.equal((await call('GET', `/v1/batches/${batch.id}`)).body.items.succeeded, 3);
});

test('a batch pauses when credits run out, says so, and starts again by itself after a top-up', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const ctx = await platformFor(store, {script: () => ({step: 'http'})});
  const {call, platform, webhooks} = ctx;
  const {body: batch} = await call('POST', '/v1/batches', {body: {items: ['https://a.example.com/1', 'https://a.example.com/2'], webhook_url: HOOK}});
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 0 WHERE project = $1', [PROJECT]);
  await drain(ctx);
  const paused = (await call('GET', `/v1/batches/${batch.id}`)).body;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.paused_reason, 'insufficient_credits');
  assert.equal(paused.items.queued, 2, 'nothing ran, nothing is lost');
  assert.equal(await reservations(store), 0);
  assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM fetch_settlements`)).rows[0].n, 0);
  await deliverHooks(platform);
  assert.deepEqual(webhooks.map(hook => hook.headers['x-fetchx-event']), ['batch.paused']);
  assert.equal(webhooks[0].payload.paused_reason, 'insufficient_credits');
  // Still no credits: it stays paused, without another event.
  await drain(ctx);
  assert.equal((await call('GET', `/v1/batches/${batch.id}`)).body.status, 'paused');
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 100 WHERE project = $1', [PROJECT]);
  // 100 credits cover one item's full reservation (160, capped at what is
  // there): the second waits for the first to settle rather than run with less.
  assert.equal((await platform.batchRunner.tick()).started, 1);
  assert.equal((await platform.batchRunner.tick()).started, 0);
  assert.equal((await call('GET', `/v1/batches/${batch.id}`)).body.status, 'running', 'waiting for credits held by its own item is not a pause');
  await drain(ctx);
  const done = (await call('GET', `/v1/batches/${batch.id}`)).body;
  assert.equal(done.status, 'finished');
  assert.equal(done.paused_reason, null);
  assert.equal(done.items.succeeded, 2);
  await deliverHooks(platform);
  assert.deepEqual(webhooks.map(hook => hook.headers['x-fetchx-event']), ['batch.paused', 'fetch.finished', 'fetch.finished', 'batch.finished']);
});

test('an item refused at its start fails alone and is free; canceling stops the rest', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const ctx = await platformFor(store, {script: request => request.render === 'always' ? {planned: ['browser', 'browser_residential']}
    : request.url.includes('/held') ? {step: 'http', hold} : {step: 'http'},
  pace: () => ({max_running: 1, start_gap_ms: 0})});
  const {call, platform, engine, webhooks} = ctx;
  // max_credits below every step the item could take: refused at its start.
  const {body: low} = await call('POST', '/v1/batches', {body: {items: [{url: 'https://a.example.com/', render: 'always', max_credits: 5}]}});
  await drain(ctx);
  const item = (await call('GET', `/v1/batches/${low.id}/items`)).body.items[0];
  assert.equal(item.status, 'failed');
  assert.equal(item.error.code, 'max_credits_too_low');
  assert.equal(item.error.details.min_credits, 10);
  assert.equal(item.request_id, null);
  assert.equal((await call('GET', `/v1/batches/${low.id}`)).body.status, 'finished');
  assert.equal(await balance(store), 100);

  // Cancel: the running item finishes (and is charged); the queued ones never start.
  const {body: batch} = await call('POST', '/v1/batches', {body: {items: ['https://b.example.com/held', 'https://b.example.com/2',
    'https://b.example.com/3'], webhook_url: HOOK}});
  assert.equal((await platform.batchRunner.tick()).started, 1);
  const canceled = await call('POST', `/v1/batches/${batch.id}/cancel`);
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.status, 'canceled');
  assert.ok(canceled.body.canceled_at);
  assert.equal(canceled.body.finished_at, null, 'an item is still running');
  assert.deepEqual(canceled.body.items, {total: 3, queued: 0, running: 1, succeeded: 0, failed: 0, canceled: 2});
  release();
  await drain(ctx);
  const over = (await call('GET', `/v1/batches/${batch.id}`)).body;
  assert.equal(over.status, 'canceled');
  assert.ok(over.finished_at);
  assert.deepEqual(over.items, {total: 3, queued: 0, running: 0, succeeded: 1, failed: 0, canceled: 2});
  assert.deepEqual(over.credits, {charged: 1});
  assert.equal(engine.jobs.size, 1);
  assert.equal((await call('POST', `/v1/batches/${batch.id}/cancel`)).body.finished_at, over.finished_at, 'canceling again changes nothing');
  await deliverHooks(platform);
  assert.deepEqual(webhooks.map(hook => hook.headers['x-fetchx-event']), ['fetch.finished', 'batch.finished']);
  assert.equal(webhooks[1].payload.status, 'canceled');
});

test('a refused paced start, an uncertain start and an orphaned item all go back to the queue and run once', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let mode = 'normal';
  const ctx = await platformFor(store, {script: () => ({step: 'http'}),
    wrapEngineFetch: fakeFetch => async (url, init) => {
      if (url.endsWith('/internal/v1/jobs') && init.method === 'POST') {
        if (mode === 'busy') {
          mode = 'normal';
          return new Response(JSON.stringify({error: {code: 'host_busy', message: 'busy', details: {retry_after_ms: 1000}}}), {status: 429});
        }
        if (mode === 'lost') {
          mode = 'normal';
          throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNRESET'}});
        }
        if (mode === 'lost-after') {
          mode = 'normal';
          await fakeFetch(url, init);
          throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNRESET'}});
        }
      }
      return fakeFetch(url, init);
    }});
  const {call, platform, engine} = ctx;
  const {body: batch} = await call('POST', '/v1/batches', {body: {items: ['https://a.example.com/1', 'https://b.example.com/2', 'https://c.example.com/3']}});
  const items = async () => (await store.pool.query('SELECT n, status, request FROM fetch_batch_items ORDER BY n')).rows;

  // The engine refuses a paced start (its host filled up since the pace answer): nothing is held, the item waits.
  mode = 'busy';
  await platform.batches.startNext({batch: batch.id, host: 'a.example.com'});
  assert.deepEqual((await items())[0], {n: 0, status: 'queued', request: null});
  assert.equal(await reservations(store), 0);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM fetch_settlements')).rows[0].n, 0);

  // A start whose answer was lost before it reached the engine: running until the reconciler finds no job, then queued again.
  mode = 'lost';
  assert.equal(await platform.batches.startNext({batch: batch.id, host: 'b.example.com'}), 'engine_down');
  const lost = (await items())[1];
  assert.equal(lost.status, 'running');
  await store.pool.query(`UPDATE fetch_settlements SET deadline = now() - interval '1 hour' WHERE request = $1`, [lost.request]);
  await platform.front.reconcile();
  assert.deepEqual((await items())[1], {n: 1, status: 'queued', request: null});

  // A start whose answer was lost after the engine took it: the reconciler settles it, the item takes the outcome.
  mode = 'lost-after';
  await platform.batches.startNext({batch: batch.id, host: 'c.example.com'});
  const taken = (await items())[2];
  assert.equal(taken.status, 'running');
  await engine.jobs.get(taken.request).done;
  engine.outbox.length = 0;
  await store.pool.query(`UPDATE fetch_settlements SET deadline = now() - interval '1 hour' WHERE request = $1`, [taken.request]);
  await platform.front.reconcile();
  assert.equal((await items())[2].status, 'succeeded');

  // An item marked running that never got a settlement row goes back to the queue.
  await store.pool.query(`UPDATE fetch_batch_items SET status = 'running', request = '00000000-0000-4000-8000-0000000000aa',
    started_at = now() - interval '1 hour' WHERE n = 0`);
  assert.equal(await platform.batches.requeueOrphans(), 1);
  assert.equal((await items())[0].status, 'queued');

  await drain(ctx);
  assert.deepEqual((await items()).map(item => item.status), ['succeeded', 'succeeded', 'succeeded']);
  assert.equal(engine.jobs.size, 3, 'every item ran exactly once');
  assert.deepEqual((await call('GET', `/v1/batches/${batch.id}`)).body.credits, {charged: 3});
  assert.equal(await reservations(store), 0);
});
