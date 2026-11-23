// docs/engine-api.json is a pinned copy of the engine's contract (the engine
// repo holds the original and tests the engine against it). These tests hold
// the platform side to it: every request the engine client sends is documented
// and valid, the fake engine the platform tests use answers as the contract
// says, and the admin portal forwards exactly the documented admin operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import spec from '../docs/engine-api.json' with {type: 'json'};
import {ENGINE_CONTRACT} from '../src/engine/client.mjs';
import {ADMIN_ROUTES, MERGED_ADMIN_ROUTES} from '../src/control-admin.mjs';
import {databaseUrl, html, openStore, platformFor, PROJECT} from './helpers.mjs';

const ajv = new Ajv2020({allErrors: true, strict: false, validateFormats: false});
const schemaId = 'urn:fetchx:engine-contract';
ajv.addSchema({$id: schemaId, components: spec.components});
const validator = schema => schema.$ref ? ajv.getSchema(schemaId + schema.$ref) : ajv.compile(schema);
function assertValid(schema, value, label) {
  const validate = validator(schema);
  assert.ok(validate(value), `${label}: ${ajv.errorsText(validate.errors)}`);
}
const component = name => ({$ref: `#/components/schemas/${name}`});
// The documented operation for a concrete method and path, with its path template.
function operationFor(method, pathname) {
  for (const [template, methods] of Object.entries(spec.paths)) {
    const pattern = new RegExp('^' + template.replace(/\{[^}]+\}/g, '[^/]+') + '$');
    if (pattern.test(pathname) && methods[method]) return {template, operation: methods[method]};
  }
  return null;
}

test('the pinned contract is the version the client speaks', () => {
  assert.equal(spec.info.version, ENGINE_CONTRACT);
});

test('the admin portal reaches exactly the documented admin operations', () => {
  const documented = Object.entries(spec.paths).filter(([path]) => path.startsWith('/internal/v1/admin/'))
    .flatMap(([path, methods]) => Object.keys(methods).map(method => `${method.toUpperCase()} ${path.slice('/internal/v1'.length)}`)).sort();
  const routes = [...ADMIN_ROUTES, ...MERGED_ADMIN_ROUTES];
  const forwarded = routes.map(([method, path]) => `${method} ${path.replace(/:([a-z]+)/g, '{$1}')}`).sort();
  assert.deepEqual(forwarded, documented);
  for (const [method, path, sendsBody] of routes) {
    const operation = spec.paths[`/internal/v1${path.replace(/:([a-z]+)/g, '{$1}')}`][method.toLowerCase()];
    assert.equal(Boolean(operation.requestBody), sendsBody, `${method} ${path} body`);
  }
});

test('engine client requests and fake engine answers and events match the contract', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const exchanges = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let openGate;
  const gate = new Promise(resolve => { openGate = resolve; });
  const {call, engine, events, platform} = await platformFor(store, {
    script: request => request.url.includes('/wall') ? {status: 'failed', planned: ['http']}
      : request.url.includes('/held') ? {hold: held} : request.url.includes('/gate') ? {hold: gate}
        : request.url.includes('/list') ? {body: html('list'), next_page: {how: 'link', url: 'https://shop.example.com/list?page=2'}}
          : {body: html('ok')},
    pace: host => ({tier: 'open', max_running: host === 'one.example.com' ? 1 : 4, start_gap_ms: 0}),
    wrapEngineFetch: fakeFetch => async (url, init) => {
      const response = await fakeFetch(url, init);
      exchanges.push({url: new URL(url), init, status: response.status, body: response.status === 204 ? null : await response.clone().arrayBuffer()});
      return response;
    },
  });

  const ok = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/a', formats: ['markdown'], tags: ['t'], webhook_url: 'https://hooks.example.com/x'}});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/a', idempotency_key: ok.body.idempotency_key, formats: ['markdown'], tags: ['t'],
    webhook_url: 'https://hooks.example.com/x'}});
  await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/wall'}});
  await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/a', render: 'always', max_credits: 1}});
  await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/a', idempotency_key: ok.body.idempotency_key}});
  await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/a', max_attempts: 9}});
  await call('POST', '/v1/fetch', {body: {url: 'http://127.0.0.1/'}});
  // Next pages: one that runs, the refusals, and one whose content is gone.
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 1000 WHERE project = $1', [PROJECT]);
  const list = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/list', tags: ['t']}});
  const page2 = await call('POST', `/v1/fetch/${list.body.id}/next`, {body: {scroll: 3, idempotency_key: 'list-2'}});
  assert.equal(page2.status, 200, JSON.stringify(page2.body));
  await call('POST', `/v1/fetch/${list.body.id}/next`, {body: {idempotency_key: 'list-2'}});
  await call('POST', `/v1/fetch/${ok.body.id}/next`);
  await call('POST', '/v1/fetch/00000000-0000-4000-8000-000000000000/next', {body: {}});
  await call('POST', `/v1/fetch/${list.body.id}/next`, {body: {url: 'https://shop.example.com/x'}});
  await call('DELETE', `/v1/fetch/${page2.body.id}`);
  await call('POST', `/v1/fetch/${page2.body.id}/next`, {body: {}});
  const pending = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/held', async: true}});
  assert.equal(pending.status, 202);
  await call('GET', `/v1/fetch/${pending.body.id}`);
  await call('GET', `/v1/fetch/${pending.body.id}/content`);
  await call('DELETE', `/v1/fetch/${pending.body.id}`);
  release();
  await engine.jobs.get(pending.body.id).done;
  await call('GET', `/v1/fetch/${ok.body.id}?include_body=false`);
  await call('GET', '/v1/fetch?limit=5&tag=t');
  await call('GET', `/v1/fetch/${ok.body.id}/content`);
  await call('GET', `/v1/fetch/${ok.body.id}/screenshot`);
  await call('DELETE', `/v1/fetch/${ok.body.id}`);
  await call('GET', `/v1/fetch/${ok.body.id}/content`);
  await call('GET', '/v1/fetch/00000000-0000-4000-8000-000000000000');
  await call('POST', '/v1/estimate', {body: {items: ['https://shop.example.com/1', {url: 'http://127.0.0.1/', render: 'always'}]}});
  // A network capture: every read, then the refusals.
  const captured = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/data', render: 'always', capture: {types: ['document', 'fetch']}}});
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  const network = `/v1/fetch/${captured.body.id}/network`;
  assert.equal((await call('GET', `${network}?content_type=json&contains=lamp&contains=desk&limit=1`)).body.items.length, 1);
  await call('GET', `${network}?limit=0`);
  await call('GET', `${network}/2`);
  await call('GET', `${network}/9`);
  await call('GET', `${network}/2/body`);
  await call('GET', `/v1/fetch/${captured.body.id}/network.har`);
  await call('GET', `/v1/fetch/${list.body.id}/network`);
  await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/data', render: 'never', capture: true}});
  await call('DELETE', `/v1/fetch/${captured.body.id}`);
  await call('GET', network);
  await platform.engine.status();
  // Batches: the check before anything is queued, the pace the queue reads,
  // and paced starts, one of them refused because its host is full.
  await call('POST', '/v1/batches', {body: {items: ['https://shop.example.com/b1', {url: 'https://shop.example.com/b2', formats: ['pdf']}]}});
  const batch = await call('POST', '/v1/batches', {body: {items: ['https://one.example.com/gate', 'https://one.example.com/2']}});
  assert.equal(batch.status, 202, JSON.stringify(batch.body));
  assert.equal((await platform.batchRunner.tick()).started, 1);
  assert.equal(await platform.batches.startNext({batch: batch.body.id, host: 'one.example.com'}), 'host_busy');
  openGate();
  await Promise.all([...engine.jobs.values()].map(job => job.done));

  const statuses = new Set();
  for (const {url, init, status, body} of exchanges) {
    const method = (init.method ?? 'GET').toLowerCase();
    const label = `${method.toUpperCase()} ${url.pathname} -> ${status}`;
    const found = operationFor(method, url.pathname);
    assert.ok(found, `${label} is not documented`);
    const {operation} = found;
    assert.equal(init.headers.authorization, `Bearer ${platform.config.engine.serviceToken}`, label);
    const parameters = operation.parameters ?? [];
    for (const name of url.searchParams.keys()) assert.ok(parameters.some(p => p.in === 'query' && p.name === name), `${label}: query ${name} is not documented`);
    for (const p of parameters.filter(p => p.in === 'query' && p.required)) assert.ok(url.searchParams.has(p.name), `${label}: ${p.name} is required`);
    if (init.body !== undefined) {
      // The engine validates the customer's request; the platform passes it on as
      // sent, so a refused one is only checked for the platform's own fields.
      const input = JSON.parse(init.body);
      const checked = [400, 413].includes(status) ? {...input, request: found.template.endsWith('/next') ? {} : {url: 'https://shop.example.com/'}} : input;
      assertValid(operation.requestBody.content['application/json'].schema, checked, `${label} request`);
    }
    const response = operation.responses[status] ?? operation.responses[`${String(status)[0]}XX`];
    assert.ok(response, `${label} is not a documented answer`);
    const media = response.content && Object.entries(response.content)[0];
    if (media?.[0] === 'application/json') assertValid(media[1].schema, JSON.parse(Buffer.from(body).toString()), label);
    statuses.add(`${method.toUpperCase()} ${found.template} ${status}`);
  }
  // The run above reached each of these answers at least once.
  for (const expected of ['POST /internal/v1/jobs 200', 'POST /internal/v1/jobs 202', 'POST /internal/v1/jobs 400', 'POST /internal/v1/jobs 402',
    'POST /internal/v1/jobs 409', 'GET /internal/v1/jobs 200', 'GET /internal/v1/jobs/{id} 200', 'GET /internal/v1/jobs/{id} 202',
    'GET /internal/v1/jobs/{id} 404', 'GET /internal/v1/jobs/{id}/content 200', 'GET /internal/v1/jobs/{id}/content 409',
    'GET /internal/v1/jobs/{id}/content 410', 'GET /internal/v1/jobs/{id}/screenshot 404', 'DELETE /internal/v1/jobs/{id} 204',
    'DELETE /internal/v1/jobs/{id} 409', 'GET /internal/v1/status 200', 'POST /internal/v1/jobs/{id}/next 200',
    'POST /internal/v1/jobs/{id}/next 400', 'POST /internal/v1/jobs/{id}/next 404', 'POST /internal/v1/jobs/{id}/next 409',
    'POST /internal/v1/jobs/{id}/next 410', 'POST /internal/v1/jobs 429', 'POST /internal/v1/requests/check 200',
    'POST /internal/v1/pace 200', 'POST /internal/v1/estimates 200', 'GET /internal/v1/jobs/{id}/network 200',
    'GET /internal/v1/jobs/{id}/network 400', 'GET /internal/v1/jobs/{id}/network 404', 'GET /internal/v1/jobs/{id}/network 410',
    'GET /internal/v1/jobs/{id}/network/{index} 200', 'GET /internal/v1/jobs/{id}/network/{index} 404',
    'GET /internal/v1/jobs/{id}/network/{index}/body 200', 'GET /internal/v1/jobs/{id}/network.har 200']) {
    assert.ok(statuses.has(expected), `not exercised: ${expected}`);
  }

  // The job.finished events the fake engine sends are what the engine sends.
  const sent = [];
  const answers = await engine.deliver({inject: async request => { sent.push(JSON.parse(request.payload)); return events.inject(request); }});
  assert.ok(sent.length >= 3);
  for (const event of sent) assertValid(component('JobFinishedEvent'), event, `event ${event.job_id}`);
  assert.ok(answers.every(answer => answer.status === 200));
});
