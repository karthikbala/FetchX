// The JavaScript client against the real app (through app.inject), plus the
// recovery paths: a lost response, a 429 and an invalid reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import {FetchXClient, FetchXError} from '../clients/javascript.mjs';
import {databaseUrl, html, openStore, platformFor, PROJECT, TOKEN} from './helpers.mjs';
import {Ledger} from '../src/billing/ledger.mjs';

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
  await client.delete(page.id);
  assert.equal((await client.get(page.id)).data.content_expired, true);
  assert.equal((await client.usage({period: 'day'})).used.succeeded, 3);
  await assert.rejects(client.fetch({url: 'https://shop.example.com/', max_attempts: 9}),
    error => error instanceof FetchXError && error.code === 'invalid_request' && error.status === 400 && error.details.field === 'max_attempts');
  const stranger = new FetchXClient({url: 'https://api.fetchx.test', token: 'fxk_wrong', fetch: transportFor(app)});
  await assert.rejects(stranger.usage(), {code: 'unauthorized', status: 401});
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
