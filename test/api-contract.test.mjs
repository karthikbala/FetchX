// docs/openapi.json is the contract. These tests hold the gateway to it: every
// documented operation exists with its scope, nothing undocumented is exposed,
// and real responses validate against the documented schemas.
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import spec from '../docs/openapi.json' with {type: 'json'};
import {registerApi, API_SCOPES} from '../src/api/v1.mjs';
import {databaseUrl, html, openStore, platformFor, PROJECT} from './helpers.mjs';

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

test('the contract is self-contained, with unique operation ids and matching path parameters', () => {
  const ids = new Set();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const operation of Object.values(methods)) {
      assert.ok(operation.operationId && !ids.has(operation.operationId), path);
      ids.add(operation.operationId);
      assert.deepEqual((operation.parameters ?? []).filter(p => p.in === 'path').map(p => p.name),
        [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name), path);
      assert.ok(Object.values(API_SCOPES).includes(operation['x-scope']), `${path} names a real scope`);
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
  registerApi(app, {service: {}, ledger: {}});
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
  const {call, engine} = await platformFor(store, {script: request => request.url.includes('/wall') ? {status: 'failed', body: 'denied'}
    : request.url.includes('/pdf') ? {content_type: 'application/pdf', body: '%PDF-1.4'}
      : request.url.includes('/list') ? {body: html('list'), step: 'browser', next_page: {how: 'click'}}
      : {body: html('hello'), data: {headers: {'set-cookie': 'sid=1; Path=/'}, cookies: [{name: 'sid', value: '1', domain: 'shop.example.com', path: '/'}]}}});
  const expect = async (method, path, status, request, specUrl = path.split('?')[0]) => {
    const response = await call(method.toUpperCase(), path, request);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
    if (response.body) assertValid(responseSchema(method, specUrl, status), response.body, `${method} ${path} ${status}`);
    return response.body;
  };
  const one = '/v1/fetch/{id}';
  const ok = await expect('post', '/v1/fetch', 200, {body: {url: 'https://shop.example.com/p', formats: ['markdown', 'text', 'links', 'metadata', 'json'], tags: ['t']}});
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
});

test('real batch responses match the contract', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, engine, events, platform} = await platformFor(store, {script: request => request.url.includes('/wall') ? {status: 'failed'} : {body: html('item')}});
  const expect = async (method, path, status, request, specUrl = path.split('?')[0]) => {
    const response = await call(method.toUpperCase(), path, request);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
    if (response.body) assertValid(responseSchema(method, specUrl, status), response.body, `${method} ${path} ${status}`);
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
