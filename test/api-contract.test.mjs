import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import spec from '../docs/openapi.json' with {type: 'json'};
import {Sealer, sha} from '../src/crypto.mjs';
import {controlKeyScope, server} from '../src/main.mjs';
import {fail} from '../src/policy.mjs';
import {registerV2, V2Gateway} from '../src/v2.mjs';
import {registerPublicFetch} from '../src/v2-public-fetch.mjs';
import {registerPublicRender} from '../src/v2-public-render.mjs';
import {registerPublicScrape} from '../src/v2-public-scrape.mjs';

const ajv = new Ajv2020({allErrors: true, strict: false, validateFormats: false});
const schemaId = 'urn:fetchx:customer-contract';
ajv.addSchema({$id: schemaId, components: spec.components});
const media = container => container.content['application/json'];
const responseSchema = (method, path, status) => {
 const response = spec.paths[path][method].responses[status];
 assert.ok(response, `${method} ${path} does not document gateway HTTP ${status}`);
 return media(response).schema;
};
function validator(schema) {
 return schema.$ref ? ajv.getSchema(schemaId + schema.$ref) : ajv.compile(schema);
}
function assertValid(schema, value, label) {
 const validate = validator(schema);
 assert.ok(validate(value), `${label}: ${ajv.errorsText(validate.errors)}`);
}

test('the customer contract is self-contained and operation IDs and path parameters are consistent', () => {
 const operationIds = new Set();
 for (const [path, methods] of Object.entries(spec.paths)) {
  for (const operation of Object.values(methods)) {
   assert.ok(operation.operationId && !operationIds.has(operation.operationId), path);
   operationIds.add(operation.operationId);
   assert.deepEqual((operation.parameters ?? []).filter(p => p.in === 'path').map(p => p.name),
    [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name), path);
  }
 }
 function checkRefs(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) {
   assert.match(value.$ref, /^#\//, 'contract references must be local');
   const target = value.$ref.slice(2).split('/').reduce((current, segment) =>
    current?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
   assert.ok(target, `unresolved reference ${value.$ref}`);
  }
  Object.values(value).forEach(checkRefs);
 }
 checkRefs(spec);
});

test('documented endpoints and scopes match all registered managed v2 routes', async t => {
 const app = Fastify();
 t.after(() => app.close());
 const actual = {};
 app.addHook('onRoute', ({method, url}) => {
  for (const verb of [method].flat()) {
   const scope = controlKeyScope(verb, url);
   if (scope) actual[`${verb} ${url.replace(/:([a-z_]+)/g, '{$1}')}`] = scope;
  }
 });
 registerV2(app, {v2: {}});
 registerPublicFetch(app);
 registerPublicRender(app);
 registerPublicScrape(app);
 const documented = {};
 for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
   documented[`${method.toUpperCase()} ${path}`] = operation['x-managed-key-scope'];
  }
 }
 assert.deepEqual(documented, actual);
});

test('all canonical examples satisfy their declared wire schemas', () => {
 for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
   const containers = Object.values(operation.responses);
   if (operation.requestBody) containers.push(operation.requestBody);
   for (const container of containers) {
    const {schema, examples} = media(container);
    for (const [name, {value}] of Object.entries(examples ?? {})) {
     assertValid(schema, value, `${method} ${path} ${name}`);
    }
   }
  }
 }
});

const fetchPath = '/v2/fetch';
const renderPath = '/v2/render';
const exampleRequest = path => structuredClone(media(spec.paths[path].post.requestBody).examples.example.value);
const token = 'synthetic-contract-provisioned-token';
const readerToken = 'fxk_synthetic_contract_reader';
const fixtureProject = 'contract-fixture';
const fixtureSession = '00000000-0000-4000-8000-000000000011';
const fixtureOperation = '00000000-0000-4000-8000-000000000012';
const fixtureArtifact = '00000000-0000-4000-8000-000000000013';
const fixtureDom = '00000000-0000-4000-8000-000000000014';
const fixtureScreenshot = '00000000-0000-4000-8000-000000000015';
const profile = (id, browser = false) => ({id, version: 1, origins: ['https://source.example'],
 methods: ['GET'], headers: [], proxy_classes: ['direct'], countries: [], ...(browser ? {browser_probe: {enabled: true}} : {})});
const fixtureAccounting = {
 provider: 'direct', reserved_tunnel_bytes: 0, observed_tunnel_bytes: null,
 estimated_micro_usd: 0, invoice_micro_usd: null, basis: 'direct_no_provider_invoice',
};

function fixture(t) {
 const sealer = new Sealer('ab'.repeat(32)), fingerprints = new Map(), operations = new Map(), artifacts = new Map();
 let retained;
 const persist = (sql, args) => {
  if (sql.startsWith('SELECT hash FROM v2_registry')) {
   const hash = fingerprints.get(JSON.stringify(args));
   return {rows: hash ? [{hash}] : []};
  }
  if (sql.startsWith('INSERT INTO v2_registry')) {
   const [kind, key, hash] = args, index = JSON.stringify([kind, key]);
   if (!fingerprints.has(index)) fingerprints.set(index, hash);
   return {rows: []};
  }
  if (sql.startsWith('SELECT input,kind FROM v2_operations')) {
   assert.equal(args[1], fixtureProject);
   return {rows: [{kind: 'http', input: sealer.seal({request: {method: 'GET'}})}]};
  }
  if (sql.startsWith('SELECT * FROM v2_operations WHERE project')) return {rows: []};
  throw new Error('Unexpected fixture query');
 };
 const gateway = {
  sealer, store: {pool: {query: async (sql, args) => persist(sql, args)}},
  config: {projects: {[fixtureProject]: {tokenHash: sha(token), v2_access_profiles: ['source.http@1', 'source.browser@1']}},
   v2: {accessProfiles: {'source.http@1': profile('source.http'), 'source.browser@1': profile('source.browser', true)}}},
  controlIdentity: {async authenticateKey(key) {
   if (key !== readerToken) fail('unauthorized', 401);
   return {project: fixtureProject, key_id: 'synthetic-reader', scopes: ['fetch:read']};
  }},
 };
 let dispatches = 0;
 const unexpectedDispatch = () => { dispatches++; throw new Error('Contract fixtures cannot dispatch'); };
 gateway.resolve = unexpectedDispatch;
 const v2 = new V2Gateway(gateway, {browserRuntime: async () => ({available: false, reason: 'browser_probe_runtime_unqualified'}),
  browserRunner: unexpectedDispatch, http: unexpectedDispatch, dnsHttp: unexpectedDispatch, relayFactory: unexpectedDispatch});
 gateway.v2 = v2;
 v2.registered = async (_kind, value) => value;
 v2.renderSession = async () => ({id: fixtureSession, proxy: {class: 'direct', country: null, provider: 'direct'}});
 v2.owned = async project => {
  assert.equal(project, fixtureProject);
  const browser = retained?.execution !== 'http';
  return {id: fixtureSession, policy: browser ? profile('source.browser', true) : profile('source.http'),
   route: sealer.seal({class: 'direct', country: null, provider: 'direct', transport: browser ? 'browser' : 'http'})};
 };
 v2.lookup = async (project, key) => {
  assert.equal(project, fixtureProject);
  const operation = operations.get(key);
  if (!operation) fail('operation_not_found', 404);
  return operation;
 };
 v2.artifact = async (project, id) => {
  assert.equal(project, fixtureProject);
  const artifact = artifacts.get(id);
  if (!artifact) fail('artifact_not_found', 404);
  return artifact;
 };
 v2.readOperation = async (project, id) => {
  if (project !== fixtureProject || id !== retained?.id) fail('operation_not_found', 404);
  return retained;
 };

 const app = server(gateway);
 t.after(async () => { await app.close(); assert.equal(dispatches, 0); });
 const inject = (method, url, payload, credential = token) => app.inject({method, url, payload,
  headers: credential ? {authorization: 'Bearer ' + credential} : {}});
 const retain = (transport, key, {status = 200, state = 'completed', error = null} = {}) => {
  const browser = transport === 'browser', kind = browser ? 'render' : 'fetch';
  const nativeKey = `public-${kind}.o.` + sha(key).slice(0, 32);
  fingerprints.set(JSON.stringify([`public_${kind}_request_v1`, sha(JSON.stringify([fixtureProject, key]))]), 'fixture-fingerprint');
  const url = 'https://source.example/data';
  const retainArtifact = (id, kind, text, contentType, extra = {}) => {
   const bytes = Buffer.from(text);
   artifacts.set(id, {id, kind, url, status, headers: {'content-type': contentType},
    decoded_body_base64: bytes.toString('base64'), decoded_sha256: sha(bytes), decoded_bytes: bytes.length, ...extra});
   return {id};
  };
  const evidence = status === null ? [] : [retainArtifact(fixtureArtifact, browser ? 'browser_response' : 'native_response',
   status === 403 ? 'Access denied' : 'Fixture response', 'text/plain', {main_document: browser})];
  if (browser && status !== null) {
   evidence.push(retainArtifact(fixtureDom, 'rendered_dom', '<main>Fixture</main>', 'text/html', {generated: true}));
   evidence.push(retainArtifact(fixtureScreenshot, 'browser_screenshot', Buffer.from([255, 216, 255, 217]), 'image/jpeg', {generated: true}));
  }
  retained = {id: fixtureOperation, session_id: fixtureSession, idempotency_key: nativeKey,
   execution: transport, state, error, created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z',
   accounting: fixtureAccounting, result: status === null ? null : {status, final_url: url, artifacts: evidence, physical_requests: 1}};
  operations.set(nativeKey, retained);
 };
 return {inject, retain};
}

function checkResponse(response, method, path, expectedStatus) {
 assert.equal(response.statusCode, expectedStatus, response.body);
 const body = response.json();
 assertValid(responseSchema(method, path, expectedStatus), body, `${method} ${path} ${expectedStatus}`);
 if (path.startsWith(fetchPath) || path.startsWith(renderPath)) assert.equal(body.gateway_http_status, response.statusCode);
 return body;
}

test('invalid facade options produce the documented gateway failure envelopes', async t => {
 const {inject} = fixture(t);
 for (const [path, patch, status, code] of [
  [fetchPath, {idempotency_key: 'not a key'}, 400, 'idempotency_key_required'],
  [fetchPath, {proxy: {class: 'direct', country: 'US'}}, 400, 'direct_country_unverified'],
  [fetchPath, {proxy: {class: 'datacenter', country: null}}, 400, 'country_required'],
  [fetchPath, {screenshot: true}, 409, 'capability_unsupported'],
  [renderPath, {wait_ms: 2001}, 400, 'browser_wait_ceiling_rejected'],
  [renderPath, {retry: true}, 400, 'browser_probe_invalid'],
 ]) {
  const request = {...exampleRequest(path), ...patch};
  assert.equal(validator(media(spec.paths[path].post.requestBody).schema)(request), false, code);
  const response = checkResponse(await inject('POST', path, request), 'post', path, status);
  assert.equal(response.error.code, code);
 }
 const unauthorized = checkResponse(await inject('POST', fetchPath, exampleRequest(fetchPath), ''), 'post', fetchPath, 401);
 assert.equal(unauthorized.error.code, 'unauthorized');
 const missingScope = checkResponse(await inject('POST', renderPath, exampleRequest(renderPath), readerToken), 'post', renderPath, 403);
 assert.equal(missingScope.error.code, 'api_key_scope_forbidden');
 const nativeError = checkResponse(await inject('GET', '/v2/capabilities', undefined, ''), 'get', '/v2/capabilities', 401);
 assert.equal(nativeError.error, 'unauthorized');
});

test('read-only Fetch recovery distinguishes retained source denial from dispatch uncertainty', async t => {
 const {inject, retain} = fixture(t), key = 'contract:recovery', path = '/v2/fetch/{key}';
 const lookup = () => inject('GET', fetchPath + '/' + encodeURIComponent(key));
 retain('http', key, {status: 403});
 const denied = checkResponse(await lookup(), 'get', path, 200);
 assert.equal(denied.success, false);
 assert.equal(denied.data.status, 403);
 assert.equal(denied.error.code, 'source_forbidden');
 assert.equal(denied.application_acceptance, 'not_evaluated');
 const projected = checkResponse(await inject('GET', '/v2/fetch/operations/' + fixtureOperation), 'get', '/v2/fetch/operations/{id}', 200);
 assert.equal(projected.idempotency_key, null);
 assert.equal(projected.idempotency_key_scope, 'internal_operation');
 assert.equal(projected.retry.same_key_replay_safe, false);
 retain('http', key, {status: null, state: 'unknown', error: 'interrupted_unknown'});
 const unknown = checkResponse(await lookup(), 'get', path, 200);
 assert.equal(unknown.data, null);
 assert.equal(unknown.error.code, 'interrupted_unknown');
 assert.equal(unknown.retry.next_action, 'recover_first');
 assert.equal(unknown.retry.new_request_allowed, false);
});

test('Render requires runtime qualification while recovery can still return a retained screenshot', async t => {
 const {inject, retain} = fixture(t);
 const capabilities = checkResponse(await inject('GET', '/v2/capabilities'), 'get', '/v2/capabilities', 200);
 assert.equal(capabilities.features.browser_render, false);
 const profiles = checkResponse(await inject('GET', '/v2/access-profiles'), 'get', '/v2/access-profiles', 200);
 assert.equal(profiles.access_profiles.find(profile => profile.id === 'source.browser').browser_probe.enabled, true);
 const denied = checkResponse(await inject('POST', renderPath, exampleRequest(renderPath)), 'post', renderPath, 409);
 assert.equal(denied.error.code, 'browser_probe_runtime_unqualified');
 assert.equal(denied.state, 'rejected');
 retain('browser', 'contract-render');
 const saved = checkResponse(await inject('GET', '/v2/render/contract-render', undefined, readerToken), 'get', '/v2/render/{key}', 200);
 assert.equal(saved.execution, 'browser');
 assert.equal(saved.data.text, '<main>Fixture</main>');
 assert.equal(saved.artifacts.find(artifact => artifact.kind === 'browser_screenshot').content_type, 'image/jpeg');
});

test('paid credit, transfer limit and render preparation shapes match the contract', async () => {
 const {quotePaidHttpCredits} = await import('../src/control-paid-credits.mjs');
 const {PUBLIC_URL_TRANSFER_LIMITS} = await import('../src/v2-public-url.mjs');
 const schema = name => ({$ref: `#/components/schemas/${name}`});
 for (const route of ['direct', 'datacenter', 'residential']) {
  assertValid(schema('PaidCreditQuote'), quotePaidHttpCredits({route}), `${route} default quote`);
  assertValid(schema('PaidCreditQuote'), quotePaidHttpCredits({route, maxTransferMb: 2.25, maxCredits: 1000}), `${route} ceiling quote`);
 }
 assertValid(schema('TransferLimits'), PUBLIC_URL_TRANSFER_LIMITS, 'public URL transfer limits');
 const request = spec.components.schemas.FetchRequest.properties;
 assert.equal(request.max_transfer_mb.minimum, PUBLIC_URL_TRANSFER_LIMITS.min_transfer_mb);
 assert.equal(request.max_transfer_mb.maximum, PUBLIC_URL_TRANSFER_LIMITS.max_transfer_mb);
 assert.equal(request.max_transfer_mb.multipleOf, PUBLIC_URL_TRANSFER_LIMITS.step_mb);
 const preparation = media(spec.paths['/v2/render/prepare'].post.requestBody).schema;
 assertValid(preparation, {url: 'https://source.example/', proxy: {class: 'direct', country: null}}, 'preparation request');
 const invalid = validator(preparation);
 assert.equal(invalid({url: 'https://source.example/', proxy: {class: 'direct', country: null}, execution: 'http'}), false,
  'preparation rejects fields the gateway rejects');
});
