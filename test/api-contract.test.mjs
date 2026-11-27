// docs/openapi.json is the contract. These tests hold the gateway to it: every
// documented operation exists with its scope, nothing undocumented is exposed,
// and real responses validate against the documented schemas.
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import spec from '../docs/openapi.json' with {type: 'json'};
import {registerApi, API_SCOPES, ANY_SCOPE} from '../src/api/v1.mjs';
import {FEATURES} from '../src/api/version.mjs';
import {databaseUrl, html, openStore, platformFor, PROJECT, TOKEN} from './helpers.mjs';

const ajv = new Ajv2020({allErrors: true, strict: false, validateFormats: false});
const schemaId = 'urn:fetchx:contract';
ajv.addSchema({$id: schemaId, components: spec.components});
const validator = schema => schema.$ref ? ajv.getSchema(schemaId + schema.$ref) : ajv.compile(schema);
function assertValid(schema, value, label) {
  const validate = validator(schema);
  assert.ok(validate(value), `${label}: ${ajv.errorsText(validate.errors)}`);
}
const responseSchema = (method, path, status) => {
  const response = spec.paths[path][method].responses[status];
  assert.ok(response, `${method} ${path} does not document HTTP ${status}`);
  return Object.values(response.content)[0].schema;
};
const specPath = url => url.replace(/:([a-z_]+)/g, '{$1}');
// Every answer names its call (X-Request-Id); every JSON answer, a HAR file aside, says it in the body too.
function assertNamed(response, method, path, specUrl, status) {
  assert.match(response.headers['x-request-id'] ?? '', /^req_[0-9a-f]{24}$/, `${method} ${path} has X-Request-Id`);
  if (response.body && !specUrl.endsWith('network.har')) {
    assert.equal(response.body.request_id, response.headers['x-request-id'], `${method} ${path} ${status} carries request_id`);
  }
}

test('the contract is self-contained, with unique operation ids and matching path parameters', () => {
  const ids = new Set();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const operation of Object.values(methods)) {
      assert.ok(operation.operationId && !ids.has(operation.operationId), path);
      ids.add(operation.operationId);
      assert.deepEqual((operation.parameters ?? []).filter(p => p.in === 'path').map(p => p.name),
        [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name), path);
      // A public operation (GET /v1/status) has no security and no scope; "any"
      // (GET /v1/me) takes any valid key, whatever its scopes.
      if (Array.isArray(operation.security) && operation.security.length === 0) assert.equal(operation['x-scope'], undefined, path);
      else assert.ok([...Object.values(API_SCOPES), ANY_SCOPE].includes(operation['x-scope']), `${path} names a real scope`);
    }
  }
  const check = value => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.match(value.$ref, /^#\//);
      const target = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key], spec);
      assert.ok(target, `unresolved ${value.$ref}`);
    }
    Object.values(value).forEach(check);
  };
  check(spec);
});

test('every registered route is documented with its scope, and nothing else is exposed', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const scopes = {};
  app.decorate('authenticate', async (req, scope) => { scopes[`${req.method} ${req.routeOptions.url}`] = scope; });
  const routes = [];
  app.addHook('onRoute', ({method, url}) => { for (const verb of [method].flat()) if (verb !== 'HEAD') routes.push([verb.toLowerCase(), url]); });
  registerApi(app, {service: {}, ledger: {}, estimator: {}, board: {}});
  await app.ready();
  const documented = Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map(method => `${method} ${path}`)).sort();
  assert.deepEqual(routes.map(([method, url]) => `${method} ${specPath(url)}`).sort(), documented);
  for (const [method, url] of routes) {
    await app.inject({method: method.toUpperCase(), url: url.replace(':id', '00000000-0000-4000-8000-000000000000')}).catch(() => {});
    assert.equal(scopes[`${method.toUpperCase()} ${url}`], spec.paths[specPath(url)][method]['x-scope'], `${method} ${url}`);
  }
});

test('every documented example matches its schema', () => {
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      for (const [name, example] of Object.entries(operation.requestBody?.content?.['application/json']?.examples ?? {})) {
        assertValid(operation.requestBody.content['application/json'].schema, example.value, `${method} ${path} request ${name}`);
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        for (const media of Object.values(response.content ?? {})) {
          for (const [name, example] of Object.entries(media.examples ?? {})) assertValid(media.schema, example.value, `${method} ${path} ${status} ${name}`);
        }
      }
    }
  }
});

test('real responses from the gateway match the contract', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {app, call, engine, platform} = await platformFor(store, {script: request => request.url.includes('/wall') ? {status: 'failed', body: 'denied'}
    : request.url.includes('/signin') ? {status: 'failed', step: 'browser', error_code: 'login_failed', page_status: 'login_required', sign_in: 'rejected',
      body: '<form><input type=password></form>', next: {action: 'update_login', retry_with_new_key: false, detail: 'Update the login.'}}
    : request.url.includes('/pdf') ? {content_type: 'application/pdf', body: '%PDF-1.4'}
      : request.url.includes('/api') ? {content_type: 'application/json', body: JSON.stringify({items: [{name: 'Lamp'}], total: 1})}
      : request.url.includes('/list') ? {body: html('list'), step: 'browser', next_page: {how: 'click'}}
      : {body: html('hello'), data: {headers: {'set-cookie': 'sid=1; Path=/'}, cookies: [{name: 'sid', value: '1', domain: 'shop.example.com', path: '/'}]}}});
  const expect = async (method, path, status, request, specUrl = path.split('?')[0]) => {
    const response = await call(method.toUpperCase(), path, request);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
    if (response.body) assertValid(responseSchema(method, specUrl, status), response.body, `${method} ${path} ${status}`);
    assertNamed(response, method, path, specUrl, status);
    return response.body;
  };
  const one = '/v1/fetch/{id}';
  const ok = await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/p', formats: ['markdown', 'text', 'links', 'metadata', 'skeleton'], tags: ['t']}});
  assert.equal(ok.data.skeleton, null, 'an HTML page has no skeleton');
  const shaped = await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/api', render: 'never', formats: ['skeleton']}});
  assert.deepEqual(shaped.data.skeleton.fields.find(row => row.path === '$.items'), {path: '$.items', type: 'array', seen: 1, items: 1});
  assert.equal(shaped.data.body, undefined);
  assert.equal(ok.status, 'succeeded');
  await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/pdf'}});
  const shot = await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/r', render: 'always', formats: ['screenshot']}});
  assert.ok(shot.data.screenshot);
  const failed = await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/wall', render: 'never', max_attempts: 2}});
  assert.equal(failed.status, 'failed');
  const pending = await expect('post', '/v1/fetch', 202, {body: {url: 'https://shop.example.com/a', async: true}});
  await engine.jobs.get(pending.id).done;
  await expect('get', `/v1/fetch/${ok.id}`, 200, undefined, one);
  await expect('get', `/v1/fetch/${ok.id}?include_body=false`, 200, undefined, one);
  await expect('get', '/v1/fetch?limit=2', 200);
  await expect('get', '/v1/usage', 200);
  await expect('delete', `/v1/fetch/${ok.id}`, 204, undefined, one);
  await expect('get', `/v1/fetch/${ok.id}`, 200, undefined, one);
  await expect('get', `/v1/fetch/${ok.id}/content`, 410, undefined, '/v1/fetch/{id}/content');
  await expect('get', `/v1/fetch/${failed.id}/screenshot`, 404, undefined, '/v1/fetch/{id}/screenshot');
  await expect('get', '/v1/fetch/00000000-0000-4000-8000-000000000000', 404, undefined, one);
  await expect('post', '/v1/fetch', 400, {body: {url: 'https://shop.example.com/', max_attempts: 9}});
  await expect('post', '/v1/fetch', 400, {body: {url: 'http://127.0.0.1/'}});
  await expect('post', '/v1/fetch', 401, {token: 'wrong', body: {url: 'https://shop.example.com/'}});
  await expect('post', '/v1/fetch', 402, {body: {url: 'https://shop.example.com/', render: 'always', max_credits: 1}});
  await expect('post', '/v1/fetch', 409, {body: {url: 'https://shop.example.com/other', idempotency_key: ok.idempotency_key}});
  await expect('post', '/v1/fetch', 413, {body: {url: 'https://shop.example.com/', method: 'POST', body: 'x'.repeat(1_000_001)}});
  await expect('get', '/v1/usage?period=year', 400);
  // Estimates, status, and maintenance on every keyed route.
  await expect('post', '/v1/estimate', 200, {body: {url: 'https://shop.example.com/p', expect: {selector: 'main'}}});
  await expect('post', '/v1/estimate', 200, {body: {items: ['https://shop.example.com/1', {url: 'http://127.0.0.1/'}, 3],
    defaults: {formats: ['markdown']}}});
  await expect('post', '/v1/estimate', 400, {body: {items: []}});
  await expect('get', '/v1/status', 200);
  await expect('get', '/v1/prices', 200);
  const pause = await platform.board.create({kind: 'maintenance', title: 'Upgrade', pause_api: true}, 'ops@example.com');
  for (const [method, path, specUrl] of [['post', '/v1/fetch'], ['get', '/v1/usage'], ['get', `/v1/fetch/${ok.id}`, one],
    ['post', '/v1/estimate']]) {
    await expect(method, path, 503, method === 'post' ? {body: {url: 'https://shop.example.com/'}} : undefined, specUrl);
  }
  await expect('get', '/v1/status', 200);
  await platform.board.resolve(pause.id, {}, 'ops@example.com');
  // Next pages, with credits to spare.
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 1000 WHERE project = $1', [PROJECT]);
  const next = '/v1/fetch/{id}/next';
  const list = await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/list', render: 'always'}});
  assert.deepEqual(list.data.next_page, {how: 'click'});
  const page2 = await expect('post', `/v1/fetch/${list.id}/next`, 200, {body: {scroll: 5}}, next);
  assert.equal(page2.data.page.number, 2);
  await expect('post', `/v1/fetch/${page2.id}/next`, 202, {body: {async: true}}, next);
  await expect('post', `/v1/fetch/${failed.id}/next`, 409, {body: {}}, next);
  await expect('post', '/v1/fetch/00000000-0000-4000-8000-000000000000/next', 404, {body: {}}, next);
  await expect('post', `/v1/fetch/${list.id}/next`, 400, {body: {scroll: 0}}, next);
  await expect('post', `/v1/fetch/${list.id}/next`, 402, {body: {max_credits: 1}}, next);
  await expect('post', `/v1/fetch/${list.id}/next`, 401, {token: 'wrong', body: {}}, next);
  await expect('delete', `/v1/fetch/${list.id}`, 204, undefined, one);
  await expect('post', `/v1/fetch/${list.id}/next`, 410, {body: {}}, next);
  // Network capture, and who is calling.
  const captured = await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/data', render: 'always', capture: true}});
  assert.equal(captured.network.captured, 2);
  const network = '/v1/fetch/{id}/network';
  const rows = await expect('get', `/v1/fetch/${captured.id}/network?contains=lamp&contains=desk`, 200, undefined, network);
  assert.deepEqual(rows.items.map(item => [item.index, item.matched]), [[2, ['lamp']]]);
  await expect('get', `/v1/fetch/${captured.id}/network?limit=0`, 400, undefined, network);
  await expect('get', `/v1/fetch/${page2.id}/network`, 404, undefined, network);
  await expect('get', `/v1/fetch/${captured.id}/network/2`, 200, undefined, `${network}/{index}`);
  await expect('get', `/v1/fetch/${captured.id}/network/9`, 404, undefined, `${network}/{index}`);
  await expect('get', `/v1/fetch/${captured.id}/network.har`, 200, undefined, '/v1/fetch/{id}/network.har');
  const body = await call('GET', `/v1/fetch/${captured.id}/network/2/body`);
  assert.deepEqual([body.status, body.headers['content-type'], body.headers['x-content-type-options']], [200, 'application/json', 'nosniff']);
  await expect('post', '/v1/fetch', 400, {body: {url: 'https://shop.example.com/data', render: 'never', capture: true}});
  await expect('delete', `/v1/fetch/${captured.id}`, 204, undefined, one);
  await expect('get', `/v1/fetch/${captured.id}/network`, 410, undefined, network);
  const me = await expect('get', '/v1/me', 200);
  const {concurrency, request_id: requestId, ...who} = me;
  assert.match(requestId, /^req_[0-9a-f]{24}$/);
  assert.deepEqual(who, {project_id: PROJECT, key_id: null, key_name: null, key_prefix: null, scopes: ['fetch:write', 'fetch:read', 'usage:read'],
    limits: {credits_per_day: null, credits_per_month: null, expires_at: null}, features: [...FEATURES]});
  // Earlier async jobs of this test may still be running.
  assert.equal(concurrency.requests.limit, 10);
  assert.ok(Number.isInteger(concurrency.requests.running) && concurrency.requests.running >= 0);
  await expect('get', '/v1/me', 401, {token: 'wrong'});
  const report = await expect('post', '/v1/feedback', 201, {body: {fetch_id: failed.id, kind: 'blocked_via_fetchx_ok_from_home',
    message: 'Loads at home.', evidence: {status_code: 200, client: 'curl from home'}}});
  await expect('post', '/v1/feedback', 200, {body: {fetch_id: failed.id, kind: 'blocked_via_fetchx_ok_from_home'}});
  await expect('post', '/v1/feedback', 201, {body: {url: 'https://shop.example.com/x', kind: 'other'}});
  await expect('post', '/v1/feedback', 400, {body: {url: 'https://shop.example.com/x', kind: 'slow'}});
  await expect('post', '/v1/feedback', 404, {body: {fetch_id: '00000000-0000-4000-8000-000000000000', kind: 'other'}});
  await expect('get', `/v1/feedback/${report.id}`, 200, undefined, '/v1/feedback/{id}');
  await expect('get', '/v1/feedback/00000000-0000-4000-8000-000000000000', 404, undefined, '/v1/feedback/{id}');
  // Saved site logins: the password goes in and never comes back.
  const oneLogin = '/v1/logins/{id}';
  const login = await expect('post', '/v1/logins', 201, {body: {site: 'login.shop.example.com', username: 'buyer@shop.example.com',
    password: 'synthetic-pass-1', name: 'Shop'}});
  assert.ok(!JSON.stringify(login).includes('synthetic-pass-1'));
  await expect('post', '/v1/logins', 409, {body: {site: 'login.shop.example.com', username: 'BUYER@shop.example.com', password: 'other-pass'}});
  await expect('post', '/v1/logins', 400, {body: {site: 'http://login.shop.example.com', username: 'u', password: 'p'}});
  await expect('post', '/v1/logins', 401, {token: 'wrong', body: {site: 'login.shop.example.com', username: 'u', password: 'p'}});
  assert.deepEqual((await expect('get', '/v1/logins', 200)).items.map(item => item.id), [login.id]);
  await expect('get', `/v1/logins/${login.id}`, 200, undefined, oneLogin);
  await expect('patch', `/v1/logins/${login.id}`, 200, {body: {password: 'synthetic-pass-2'}}, oneLogin);
  await expect('patch', `/v1/logins/${login.id}`, 400, {body: {}}, oneLogin);
  await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/orders', login: login.id}});
  await expect('post', '/v1/fetch', 400, {body: {url: 'https://shop.example.com/orders', login: 'mine'}});
  const refused = await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/signin', login: login.id}});
  assert.deepEqual([refused.status, refused.page_status, refused.error.code, refused.error.next.action, refused.attempts[0].sign_in, refused.credits.charged],
    ['failed', 'login_required', 'login_failed', 'update_login', 'rejected', 0]);
  // A client that sends Content-Type: application/json on every call, with no body.
  const jsonHeaders = {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'};
  const deleted = await app.inject({method: 'DELETE', url: `/v1/logins/${login.id}`, headers: jsonHeaders});
  assert.equal(deleted.statusCode, 204, deleted.body);
  const emptyPost = await app.inject({method: 'POST', url: '/v1/fetch', headers: jsonHeaders});
  assert.deepEqual([emptyPost.statusCode, emptyPost.json().error.code], [400, 'invalid_request'], 'a POST still needs its body');
  const poisoned = await app.inject({method: 'POST', url: '/v1/logins', headers: jsonHeaders,
    payload: '{"site":"login.shop.example.com","username":"u","password":"p","__proto__":{"x":1}}'});
  assert.equal(poisoned.statusCode, 400, 'prototype poisoning is still refused');
  await expect('get', `/v1/logins/${login.id}`, 404, undefined, oneLogin);
  await expect('delete', `/v1/logins/${login.id}`, 404, undefined, oneLogin);
  // A request's own secrets: the names of those used come back, never a value;
  // nothing is kept to go on from, and staff are never shown such a request.
  const secretValue = 'Fixture "Pass" 2026!';
  const secret = await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/list', render: 'always', allow_hosts: ['shop.example.com'],
    secrets: {password: {value: secretValue, origins: ['https://shop.example.com']}},
    actions: [{type: 'fill_secret', selector: '#password', secret: 'password'}]}});
  assert.deepEqual([secret.status, secret.secrets_used], ['succeeded', ['password']]);
  assert.ok(!JSON.stringify(secret).includes(secretValue));
  const listed = (await expect('get', '/v1/fetch?limit=1', 200)).items[0];
  assert.deepEqual([listed.id, listed.secrets_used], [secret.id, ['password']]);
  await expect('post', `/v1/fetch/${secret.id}/next`, 410, {body: {}}, next);
  const unstored = await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/list', render: 'always', store: false}});
  assert.equal(unstored.secrets_used, undefined);
  assert.equal((await expect('post', `/v1/fetch/${unstored.id}/next`, 410, {body: {}}, next)).error.code, 'not_stored');
  const staff = await expect('post', '/v1/feedback', 400, {body: {fetch_id: secret.id, kind: 'wrong_content'}});
  assert.deepEqual([staff.error.code, staff.error.details.field], ['secret_not_allowed_here', 'fetch_id']);
});

test('a 503 unavailable says when to retry', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call} = await platformFor(store, {wrapEngineFetch: () => async () => { throw Object.assign(new Error('down'), {cause: {code: 'ECONNREFUSED'}}); }});
  for (const [method, path, specUrl, body] of [['post', '/v1/fetch', '/v1/fetch', {url: 'https://shop.example.com/'}],
    ['get', '/v1/fetch/00000000-0000-4000-8000-000000000000/network', '/v1/fetch/{id}/network']]) {
    const response = await call(method.toUpperCase(), path, {body});
    assert.equal(response.status, 503, JSON.stringify(response.body));
    assert.equal(response.headers['retry-after'], '30');
    assert.equal(response.body.error.code, 'unavailable');
    assert.equal(response.body.error.retry_after_seconds, 30);
    assert.equal(response.body.error.details.status_url, 'https://fetchx.ai/status');
    assertValid(responseSchema(method, specUrl, 503), response.body, `${method} ${path}`);
    assertNamed(response, method, path, specUrl, 503);
  }
});

test('real batch responses match the contract', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, engine, events, platform} = await platformFor(store, {script: request => request.url.includes('/wall') ? {status: 'failed'} : {body: html('item')}});
  const expect = async (method, path, status, request, specUrl = path.split('?')[0]) => {
    const response = await call(method.toUpperCase(), path, request);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
    if (response.body) assertValid(responseSchema(method, specUrl, status), response.body, `${method} ${path} ${status}`);
    assertNamed(response, method, path, specUrl, status);
    return response.body;
  };
  const one = '/v1/batches/{id}';
  const items = '/v1/batches/{id}/items';
  // Each running item holds its worst case (160 credits): room for both at once.
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 1000 WHERE project = $1', [PROJECT]);
  const body = {items: ['https://shop.example.com/1', {url: 'https://shop.example.com/wall', formats: ['text']}],
    defaults: {formats: ['markdown']}, webhook_url: 'https://hooks.example.com/b', idempotency_key: 'contract-batch', tags: ['t']};
  const batch = await expect('post', '/v1/batches', 202, {body});
  await expect('post', '/v1/batches', 200, {body});
  await expect('post', '/v1/batches', 409, {body: {...body, items: ['https://shop.example.com/2']}});
  await expect('post', '/v1/batches', 400, {body: {items: ['http://127.0.0.1/']}});
  await expect('post', '/v1/batches', 400, {body: {items: []}});
  await expect('post', '/v1/batches', 401, {token: 'wrong', body});
  await expect('get', `/v1/batches/${batch.id}/items`, 200, undefined, items);
  await platform.batchRunner.tick();
  await Promise.all([...engine.jobs.values()].map(job => job.done));
  await engine.deliver(events);
  await expect('get', `/v1/batches/${batch.id}/items?order=finished`, 200, undefined, items);
  const done = await expect('get', `/v1/batches/${batch.id}`, 200, undefined, one);
  assert.equal(done.status, 'finished');
  const page = await expect('get', `/v1/batches/${batch.id}/items?limit=1`, 200, undefined, items);
  await expect('get', `/v1/batches/${batch.id}/items?limit=1&cursor=${page.next_cursor}&results=false`, 200, undefined, items);
  await expect('get', `/v1/batches/${batch.id}/items?status=nope`, 400, undefined, items);
  await expect('get', '/v1/batches?limit=1', 200);
  await expect('get', '/v1/batches?status=nope', 400);
  await expect('post', `/v1/batches/${batch.id}/cancel`, 200, undefined, '/v1/batches/{id}/cancel');
  await expect('get', '/v1/batches/00000000-0000-4000-8000-000000000000', 404, undefined, one);
  await expect('get', '/v1/batches/00000000-0000-4000-8000-000000000000/items', 404, undefined, items);
  await expect('post', '/v1/batches/00000000-0000-4000-8000-000000000000/cancel', 404, undefined, '/v1/batches/{id}/cancel');
  const queued = await expect('post', '/v1/batches', 202, {body: {items: ['https://shop.example.com/3', 'https://shop.example.com/4']}});
  await expect('post', `/v1/batches/${queued.id}/cancel`, 200, undefined, '/v1/batches/{id}/cancel');
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 0 WHERE project = $1', [PROJECT]);
  await expect('post', '/v1/batches', 402, {body: {items: ['https://shop.example.com/5']}});
});

test('real browser session responses match the contract', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, engine} = await platformFor(store, {sessionScript: input => input.allow_hosts[0] === 'busy.example.com'
    ? {refuse: {status: 503, code: 'browser_capacity', details: {retry_after_seconds: 30}}} : {}});
  const expect = async (method, path, status, request, specUrl = path.split('?')[0]) => {
    const response = await call(method.toUpperCase(), path, request);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
    if (response.body) assertValid(responseSchema(method, specUrl, status), response.body, `${method} ${path} ${status}`);
    return response.body;
  };
  const all = '/v1/browser-sessions';
  const one = '/v1/browser-sessions/{id}';
  const fill = '/v1/browser-sessions/{id}/fill';
  const body = {allow_hosts: ['shop.example.com', 'login.shop.example.com'], ttl_s: 120, idle_ttl_s: 30, idempotency_key: 'contract-session',
    secrets: {pin: {value: 'synthetic-pin-1', origins: ['https://login.shop.example.com']}}};
  const session = await expect('post', all, 201, {body});
  assert.deepEqual([session.status, session.idempotency_key, session.ws_url, session.credits.max, session.credits.charged],
    ['open', 'contract-session', `wss://app.fetchx.ai/v1/browser-sessions/${session.id}/ws`, 10, 0]);
  assert.ok(!JSON.stringify(session).includes('synthetic-pin-1'));
  assert.equal((await expect('post', all, 200, {body})).id, session.id);
  await expect('post', all, 409, {body: {...body, ttl_s: 300}});
  await expect('post', all, 400, {body: {allow_hosts: ['shop.example.com'], route: {class: 'mobile'}}});
  await expect('post', all, 400, {body: {allow_hosts: ['shop.example.com'], login: '00000000-0000-4000-8000-000000000000'}});
  await expect('post', all, 401, {token: 'wrong', body});
  await expect('post', all, 402, {body: {allow_hosts: ['shop.example.com'], max_credits: 5}});
  const busy = await expect('post', all, 503, {body: {allow_hosts: ['busy.example.com']}});
  assert.deepEqual([busy.error.code, busy.error.details.reason], ['unavailable', 'browser_capacity']);
  await expect('post', all, 201, {body: {allow_hosts: ['shop.example.com'], route: {class: 'residential', country: 'GB'}, max_credits: 60}});
  const full = await expect('post', all, 429, {body: {allow_hosts: ['shop.example.com']}});
  assert.deepEqual(full.error.details, {limit: 'browser_sessions', max: 2, running: 2, retry_after_seconds: 30});
  const me = await expect('get', '/v1/me', 200);
  assert.deepEqual(me.concurrency.browser_sessions, {limit: 2, running: 2});
  await expect('get', `/v1/browser-sessions/${session.id}`, 200, undefined, one);
  assert.equal((await expect('get', `${all}?status=open`, 200)).items.length, 2);
  await expect('get', `${all}?status=nope`, 400);
  await expect('get', '/v1/browser-sessions/00000000-0000-4000-8000-000000000000', 404, undefined, one);
  const filled = await expect('post', `/v1/browser-sessions/${session.id}/fill`, 200, {body: {secret: 'pin', selector: '#pin',
    frame_url: 'https://login.shop.example.com/sign-in'}}, fill);
  assert.deepEqual(filled, {secret: 'pin', frame_url: 'https://login.shop.example.com/sign-in', request_id: filled.request_id});
  await expect('post', `/v1/browser-sessions/${session.id}/fill`, 400, {body: {secret: 'pin'}}, fill);
  await expect('post', `/v1/browser-sessions/${session.id}/fill`, 403, {body: {secret: 'pin', selector: '#pin', frame_url: 'https://shop.example.com/'}}, fill);
  await expect('post', `/v1/browser-sessions/${session.id}/fill`, 404, {body: {secret: 'nope', selector: '#pin'}}, fill);
  await expect('post', `/v1/browser-sessions/${session.id}/fill`, 409, {body: {secret: 'pin', selector: '#missing',
    frame_url: 'https://login.shop.example.com/'}}, fill);
  const receipt = await expect('delete', `/v1/browser-sessions/${session.id}`, 200, undefined, one);
  assert.deepEqual([receipt.status, receipt.close_reason, receipt.secrets_used, receipt.credits.charged, receipt.credits.breakdown.step_credits],
    ['closed', 'client', ['pin'], 10, 10]);
  assert.equal((await expect('delete', `/v1/browser-sessions/${session.id}`, 200, undefined, one)).credits.charged, 10);
  await expect('post', `/v1/browser-sessions/${session.id}/fill`, 410, {body: {secret: 'pin', selector: '#pin'}}, fill);
  await expect('delete', '/v1/browser-sessions/00000000-0000-4000-8000-000000000000', 404, undefined, one);
  await expect('get', `${all}?status=closed`, 200);
  await expect('get', all, 200);
  assert.equal(engine.sessions.size, 2);
});
