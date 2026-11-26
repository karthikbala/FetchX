// The JavaScript client against the real app (through app.inject), plus the
// recovery paths: a lost response, a 429 and an invalid reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import {FetchXClient, FetchXError} from '../clients/javascript.mjs';
import {databaseUrl, html, openStore, platformFor, PROJECT, TOKEN} from './helpers.mjs';
import {Ledger} from '../src/billing/ledger.mjs';
import {FEATURES} from '../src/api/version.mjs';

const skip = !databaseUrl;
// A fetch() that calls the app in-process; `before` and `after` can fake a lost reply.
const transportFor = (app, {before, after} = {}) => async (url, options) => {
  const {pathname, search} = new URL(url);
  await before?.(options);
  const response = await app.inject({method: options.method, url: pathname + search, headers: options.headers, payload: options.body});
  await after?.(options, response);
  return new Response(response.statusCode === 204 ? null : response.rawPayload, {status: response.statusCode, headers: response.headers});
};

test('the client covers every endpoint against the real app', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {app} = await platformFor(store, {script: request => request.url.includes('.pdf') ? {content_type: 'application/pdf', body: '%PDF-1.4'}
    : request.url.includes('/list') ? {body: html('list page'), next_page: {how: 'link', url: 'https://shop.example.com/list?page=2'}}
      : {body: html('client page')}});
  const client = new FetchXClient({url: 'https://api.fetchx.test/', token: TOKEN, fetch: transportFor(app)});
  const page = await client.fetch({url: 'https://shop.example.com/a', formats: ['markdown'], tags: ['sdk']});
  assert.equal(page.status, 'succeeded');
  assert.match(page.data.markdown, /client page/);
  assert.match(page.idempotency_key, /^[0-9a-f-]{36}$/, 'the client sets a key so retries are safe');
  assert.equal((await client.get(page.id, {includeBody: false})).data.body, undefined);
  assert.deepEqual((await client.list({tag: 'sdk'})).items.map(item => item.id), [page.id]);
  const pdf = await client.fetch({url: 'https://shop.example.com/file.pdf'});
  const download = await client.content(pdf.id);
  assert.equal(new TextDecoder().decode(download.body), '%PDF-1.4');
  assert.equal(download.contentType, 'application/pdf');
  await assert.rejects(client.screenshot(pdf.id), {code: 'not_found', status: 404});
  const pending = await client.fetch({url: 'https://shop.example.com/later', async: true});
  assert.equal(pending.status, 'pending');
  assert.equal((await client.wait(pending.id, {intervalMs: 20})).status, 'succeeded');
  const list = await client.fetch({url: 'https://shop.example.com/list'});
  const second = await client.nextPage(list.id, {scroll: 'off'});
  assert.equal(second.status, 'succeeded');
  assert.equal(second.url, 'https://shop.example.com/list?page=2');
  assert.deepEqual([second.data.page.number, second.data.page.previous_id], [2, list.id]);
  assert.match(second.idempotency_key, /^[0-9a-f-]{36}$/);
  await assert.rejects(client.nextPage(page.id), error => error.code === 'no_next_page' && error.status === 409 && error.details.reason === 'none_found');
  await client.delete(page.id);
  assert.equal((await client.get(page.id)).data.content_expired, true);
  assert.equal((await client.usage({period: 'day'})).used.succeeded, 5);
  assert.equal((await client.balance()).credits, (await new Ledger({store, config: {}}).balance(PROJECT)).available);
  const estimate = await client.estimate({items: ['https://shop.example.com/a', 'https://shop.example.com/b'], defaults: {render: 'never'}});
  assert.equal(estimate.kind, 'batch');
  assert.equal(estimate.estimated, 2);
  assert.equal((await client.status()).status, 'operational');
  const prices = await client.prices();
  assert.deepEqual([prices.steps.http.credits, prices.steps.browser_residential.credits, prices.trial_credits], [1, 25, 1000]);
  // A network capture, and who is calling.
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 1000 WHERE project = $1', [PROJECT]);
  const captured = await client.fetch({url: 'https://shop.example.com/data', render: 'always', capture: {types: ['document', 'fetch']}});
  assert.equal(captured.network.captured, 2);
  const found = await client.network(captured.id, {contains: ['Lamp', 'desk'], first_party: true});
  assert.deepEqual(found.items.map(item => [item.index, item.matched]), [[2, ['lamp']]]);
  assert.equal((await client.network(captured.id, {contains: 'lamp', limit: 1})).items.length, 1);
  assert.equal((await client.networkCall(captured.id, 2)).response.body, '{"items":[{"name":"Lamp"}]}');
  const raw = await client.networkBody(captured.id, 2);
  assert.deepEqual([new TextDecoder().decode(raw.body), raw.contentType], ['{"items":[{"name":"Lamp"}]}', 'application/json']);
  assert.equal((await client.networkHar(captured.id)).log.version, '1.2');
  await assert.rejects(client.network(page.id), {code: 'capture_not_found', status: 404});
  const {request_id: meRequestId, ...me} = await client.me();
  assert.match(meRequestId, /^req_[0-9a-f]{24}$/);
  assert.deepEqual(me, {project_id: PROJECT, key_id: null, key_name: null, key_prefix: null,
    scopes: ['fetch:write', 'fetch:read', 'usage:read'], limits: {credits_per_day: null, credits_per_month: null, expires_at: null},
    concurrency: {requests: {limit: 10, running: 0}}, features: [...FEATURES]});
  const report = await client.sendFeedback({fetch_id: captured.id, kind: 'wrong_content', message: 'Prices missing.', evidence: {status_code: 200}});
  assert.deepEqual([report.status, report.fetch_id, report.evidence], ['received', captured.id, {status_code: 200}]);
  assert.equal((await client.getFeedback(report.id)).id, report.id);
  await assert.rejects(client.sendFeedback({url: 'https://shop.example.com/', kind: 'slow'}), {code: 'invalid_request', status: 400});
  // Saved site logins: the password goes in and never comes back.
  const login = await client.saveLogin({site: 'login.shop.example.com', username: 'buyer@shop.example.com', password: 'synthetic-pass-1', name: 'Shop'});
  assert.deepEqual([login.site, login.status, login.signed_in, login.last_sign_in], ['login.shop.example.com', 'new', false, null]);
  assert.ok(!JSON.stringify(login).includes('synthetic-pass-1') && !login.username.includes('buyer'));
  assert.deepEqual((await client.listLogins()).items.map(item => item.id), [login.id]);
  assert.equal((await client.getLogin(login.id)).name, 'Shop');
  assert.equal((await client.updateLogin(login.id, {name: 'Shop (ops)'})).name, 'Shop (ops)');
  await assert.rejects(client.saveLogin({site: 'login.shop.example.com', username: 'BUYER@shop.example.com', password: 'other-pass'}),
    error => error.code === 'login_exists' && error.status === 409 && error.details.id === login.id);
  assert.equal(await client.deleteLogin(login.id), undefined);
  await assert.rejects(client.getLogin(login.id), {code: 'not_found', status: 404});
  await assert.rejects(client.fetch({url: 'https://shop.example.com/', max_attempts: 9}),
    error => error instanceof FetchXError && error.code === 'invalid_request' && error.status === 400 && error.details.field === 'max_attempts'
      && /^req_[0-9a-f]{24}$/.test(error.requestId));
  const stranger = new FetchXClient({url: 'https://api.fetchx.test', token: 'fxk_wrong', fetch: transportFor(app)});
  await assert.rejects(stranger.usage(), {code: 'unauthorized', status: 401});
});

test('the client submits a batch, reads it back and follows its results to the end', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {app, engine, events, platform} = await platformFor(store, {script: request => request.url.includes('/wall') ? {status: 'failed'}
    : {body: html('batch page')}});
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 1000 WHERE project = $1', [PROJECT]);
  const client = new FetchXClient({url: 'https://api.fetchx.test', token: TOKEN, fetch: transportFor(app)});
  const batch = await client.submitBatch({items: ['https://shop.example.com/1', 'https://shop.example.com/wall'], defaults: {formats: ['markdown']}});
  assert.equal(batch.status, 'running');
  assert.match(batch.idempotency_key, /^[0-9a-f-]{36}$/, 'the client sets a key so retries are safe');
  assert.equal((await client.submitBatch({items: ['https://shop.example.com/1', 'https://shop.example.com/wall'], defaults: {formats: ['markdown']},
    idempotency_key: batch.idempotency_key})).id, batch.id);
  assert.deepEqual((await client.listBatches({status: 'running'})).items.map(item => item.id), [batch.id]);
  await platform.batchRunner.tick();
  await Promise.all([...engine.jobs.values()].map(job => job.done));
  await engine.deliver(events);
  const seen = [];
  for await (const item of client.batchResults(batch.id, {intervalMs: 10})) seen.push([item.index, item.status, item.result?.status]);
  assert.deepEqual(seen.sort(), [[0, 'succeeded', 'succeeded'], [1, 'failed', 'failed']]);
  assert.equal((await client.getBatch(batch.id)).status, 'finished');
  assert.deepEqual((await client.batchItems(batch.id, {status: 'failed', results: false})).items.map(item => item.index), [1]);
  assert.equal((await client.cancelBatch(batch.id)).status, 'finished', 'a finished batch stays finished');
  await assert.rejects(client.submitBatch({items: []}), {code: 'invalid_request', status: 400});
  await assert.rejects(client.getBatch('00000000-0000-4000-8000-000000000000'), {code: 'not_found', status: 404});
});

test('a lost reply is resent with the same key: one result, one charge', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {app, engine} = await platformFor(store, {script: () => ({body: html('once')})});
  let lost = 0;
  const client = new FetchXClient({url: 'https://api.fetchx.test', token: TOKEN, retries: 2, fetch: transportFor(app, {
    after: async () => { if (lost++ === 0) throw new Error('connection reset after the request was processed'); },
  })});
  const result = await client.fetch({url: 'https://shop.example.com/once'});
  assert.equal(result.status, 'succeeded');
  assert.equal(engine.jobs.size, 1, 'the engine ran one job');
  assert.equal((await new Ledger({store, config: {}}).balance(PROJECT)).credits, 99, 'charged once');
});

test('429 and 503 wait and resend; other errors and bad replies do not', async () => {
  const seen = [];
  const replies = [Response.json({error: {code: 'too_many_requests', message: 'busy', retry_after_seconds: 0}}, {status: 429}),
    Response.json({id: 'r1', status: 'succeeded'})];
  const client = new FetchXClient({url: 'https://api.fetchx.test', token: 'fxk_x', fetch: async (_url, options) => {
    seen.push(JSON.parse(options.body).idempotency_key);
    return replies.shift();
  }});
  assert.equal((await client.fetch({url: 'https://shop.example.com/'})).id, 'r1');
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'the resend reuses the key');

  // Maintenance (from the gateway) and nginx's fallback while the gateway restarts are both waited out.
  const paused = [Response.json({error: {code: 'maintenance', message: 'paused', retry_after_seconds: 0, details: {status_url: 'https://fetchx.ai/status'}}}, {status: 503}),
    Response.json({error: {code: 'unavailable', message: 'restarting', retry_after_seconds: 0}}, {status: 503}),
    Response.json({id: 'r2', status: 'succeeded'})];
  const waiting = new FetchXClient({url: 'https://api.fetchx.test', token: 'fxk_x', retries: 2, fetch: async () => paused.shift()});
  assert.equal((await waiting.fetch({url: 'https://shop.example.com/'})).id, 'r2');

  let posts = 0;
  const conflicted = new FetchXClient({url: 'https://api.fetchx.test', token: 'fxk_x', fetch: async () => {
    posts++;
    return Response.json({error: {code: 'idempotency_conflict', message: 'used'}}, {status: 409});
  }});
  await assert.rejects(conflicted.fetch({url: 'https://shop.example.com/', idempotency_key: 'k1'}),
    error => error.code === 'idempotency_conflict' && error.idempotencyKey === 'k1');
  assert.equal(posts, 1);

  const broken = new FetchXClient({url: 'https://api.fetchx.test', token: 'fxk_secret', retries: 0,
    fetch: async () => new Response('<html>proxy error page</html>', {status: 502})});
  await assert.rejects(broken.fetch({url: 'https://shop.example.com/'}), error => {
    assert.equal(error.code, 'invalid_response');
    assert.ok(!String(error).includes('proxy error page') && !String(error).includes('fxk_secret'));
    return true;
  });
  assert.throws(() => new FetchXClient({url: 'https://api.fetchx.test'}), {code: 'client_config_missing'});
});
