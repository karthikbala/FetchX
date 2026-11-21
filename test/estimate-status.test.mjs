// POST /v1/estimate (src/fetch/estimate.mjs), GET /v1/status and maintenance
// (src/status.mjs), retired and unknown routes and deprecation headers
// (src/api/lifecycle.mjs), and docs/changelog.json. The engine is the fake one;
// its estimates are scripted per host.
import assert from 'node:assert/strict';
import test from 'node:test';
import spec from '../docs/openapi.json' with {type: 'json'};
import changelog from '../docs/changelog.json' with {type: 'json'};
import {expandEstimateBody, MAX_ESTIMATE_ITEMS} from '../src/fetch/estimate.mjs';
import {API_VERSION} from '../src/api/version.mjs';
import {databaseUrl, openStore, platformFor, PROJECT, UNMETERED_TOKEN} from './helpers.mjs';

const usage = (step, {share = 1, captcha = 0, bytes = [15_000_000, 25_000_000], seconds = [50, 80], rate = 0.9, requests = 40} = {}) => ({
  requests, succeeded: Math.round(requests * rate), success_rate: rate, seconds: {p50: seconds[0], p90: seconds[1]},
  steps: [{step, share, captcha_share: captcha, wire_bytes: {p50: bytes[0], p90: bytes[1]}, seconds: {p50: seconds[0], p90: seconds[1]},
    samples: requests}], since: '2026-11-01T00:00:00.000Z'});
const ESTIMATES = {
  history: {'shop.example.com': usage('browser_residential')},
  pace: {'shop.example.com': {tier: 'guarded', max_running: 2, start_gap_ms: 4000}},
  cooling: {'cool.example.com': {retry_after_seconds: 120}},
  defaults: {requests: 50, steps: [{step: 'http', share: 1, captcha_share: 0, wire_bytes: {p50: 100_000, p90: 1_000_000},
    seconds: {p50: 1.5, p90: 4}, samples: 50}]},
};

test('an estimate body is one fetch body or a batch body, merged item over defaults', () => {
  assert.deepEqual(expandEstimateBody({url: 'https://a.example.com/', render: 'always'}),
    {kind: 'fetch', items: [{index: 0, request: {url: 'https://a.example.com/', render: 'always'}}]});
  const batch = expandEstimateBody({items: ['https://a.example.com/1', {url: 'https://a.example.com/2', render: 'never'}, 7,
    {url: 'https://a.example.com/3', async: true}], defaults: {render: 'always', formats: ['markdown']}, webhook_url: 'https://hooks.example.com/x'});
  assert.equal(batch.kind, 'batch');
  assert.deepEqual(batch.items[0].request, {render: 'always', formats: ['markdown'], url: 'https://a.example.com/1'});
  assert.deepEqual(batch.items[1].request, {render: 'never', formats: ['markdown'], url: 'https://a.example.com/2'});
  assert.equal(batch.items[2].error.details.field, 'items[2]');
  assert.equal(batch.items[3].error.details.field, 'items[3].async');
  const refused = body => { try { expandEstimateBody(body); } catch (error) { return error.details.field; } return null; };
  assert.equal(refused([]), 'body');
  assert.equal(refused({render: 'always'}), 'url');
  assert.equal(refused({items: []}), 'items');
  assert.equal(refused({items: Array(MAX_ESTIMATE_ITEMS + 1).fill('https://a.example.com/')}), 'items');
  assert.equal(refused({items: ['https://a.example.com/'], defaults: {url: 'https://b.example.com/'}}), 'defaults.url');
  assert.equal(refused({items: ['https://a.example.com/'], defaults: {idempotency_key: 'k'}}), 'defaults.idempotency_key');
  assert.equal(refused({items: ['https://a.example.com/'], extra: 1}), 'extra');
});

test('estimates price each request from site history, the price table, max_credits and the balance', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, engine} = await platformFor(store, {estimates: ESTIMATES});
  const estimate = (body, options = {}) => call('POST', '/v1/estimate', {body, ...options});

  // A site with history: browser_residential at 15 MB (25 + 10 MB x 5), 90% of requests succeed.
  let answer = await estimate({url: 'https://shop.example.com/search'});
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  let [item] = answer.body.items;
  assert.equal(answer.body.kind, 'fetch');
  assert.equal(item.basis, 'history');
  assert.equal(item.step, 'browser_residential');
  assert.deepEqual(item.credits, {expected: 68, typical: 75, high: 125, hold: 160});
  assert.deepEqual(item.seconds, {typical: 50, high: 80});
  assert.equal(item.success_rate, 0.9);
  assert.deepEqual(answer.body.credits, {expected: 68, typical: 75, high: 125});
  assert.deepEqual(answer.body.balance, {credits: 100, covers_expected: true, covers_high: false});
  assert.deepEqual(answer.body.notes.map(note => note.code), ['balance_may_run_out']);
  assert.equal(engine.calls.filter(c => c.url.startsWith('/internal/v1/jobs')).length, 0, 'nothing was sent');
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM credit_reservations')).rows[0].n, 0, 'nothing was reserved');

  // max_credits 20 rules out the step this site needs: the estimate says so.
  answer = await estimate({url: 'https://shop.example.com/search', max_credits: 20});
  [item] = answer.body.items;
  assert.equal(item.credits.hold, 20);
  assert.deepEqual(item.notes.map(note => note.code), ['likely_needs_more_credits']);
  assert.match(item.notes[0].message, /max_credits 20/);
  assert.equal(item.step, 'http');

  // Deeper scrolling adds traffic and time on browser steps.
  answer = await estimate({url: 'https://shop.example.com/search', scroll: 14});
  [item] = answer.body.items;
  assert.equal(item.credits.typical, 25 + 20 * 5, '4 screens past 10 add 10 MB');
  assert.deepEqual(item.seconds, {typical: 62, high: 92});

  // No history: figures from other sites for the first planned step, or assumed.
  answer = await estimate({url: 'https://new.example.org/', render: 'never'});
  [item] = answer.body.items;
  assert.equal(item.basis, 'defaults');
  assert.equal(item.step, 'http');
  assert.deepEqual(item.credits, {expected: 1, typical: 1, high: 1, hold: item.credits.hold});
  assert.deepEqual(item.notes.map(note => note.code), ['no_history']);
  answer = await estimate({url: 'https://new.example.org/', render: 'always'});
  assert.equal(answer.body.items[0].basis, 'assumed');
  assert.equal(answer.body.items[0].step, 'browser');
  assert.deepEqual(answer.body.items[0].seconds, {typical: 30, high: 60});

  // Every route resting, a refused URL, and a max_credits below every step.
  answer = await estimate({url: 'https://cool.example.com/'});
  assert.ok(answer.body.items[0].notes.some(note => note.code === 'cooling_down' && /120 s/.test(note.message)));
  answer = await estimate({url: 'http://127.0.0.1/'});
  assert.equal(answer.status, 200);
  assert.equal(answer.body.items[0].error.code, 'url_not_allowed');
  assert.equal(answer.body.estimated, 0);
  answer = await estimate({url: 'https://shop.example.com/', render: 'always', max_credits: 5});
  assert.deepEqual(answer.body.items[0].notes.map(note => note.code), ['max_credits_too_low']);
  assert.equal(answer.body.items[0].basis, 'none');
  assert.equal(answer.body.items[0].credits.typical, 0);
  answer = await estimate({url: 'https://shop.example.com/', max_credits: 0});
  assert.equal(answer.body.items[0].error.details.field, 'max_credits');

  // A batch: hosts side by side, one host's items paced; totals and balance.
  answer = await estimate({items: ['https://shop.example.com/1', 'https://shop.example.com/2', 'https://shop.example.com/3',
    {url: 'https://new.example.org/', render: 'never'}, 'http://10.0.0.1/']});
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.kind, 'batch');
  assert.equal(answer.body.requests, 5);
  assert.equal(answer.body.estimated, 4);
  assert.deepEqual(answer.body.credits, {expected: 68 * 3 + 1, typical: 75 * 3 + 1, high: 125 * 3 + 1});
  assert.deepEqual(answer.body.seconds, {typical: 75, high: 120}, 'three 50 s pages two at a time on the slowest site');
  assert.deepEqual(answer.body.hosts['shop.example.com'], {requests: 3, pace: ESTIMATES.pace['shop.example.com'],
    credits: {expected: 204, high: 375}});
  assert.deepEqual(answer.body.notes.map(note => note.code), ['insufficient_credits']);
  assert.equal(answer.body.items[4].error.code, 'url_not_allowed');
  assert.equal(answer.body.balance.covers_expected, false);

  // A project that is not metered still sees prices, but no balance.
  answer = await estimate({url: 'https://shop.example.com/search'}, {token: UNMETERED_TOKEN});
  assert.deepEqual(answer.body.balance, {credits: null, covers_expected: true, covers_high: true});
  assert.equal(answer.body.items[0].credits.typical, 75);

  // Refusals: bad bodies, no key.
  assert.equal((await estimate({items: []})).body.error.code, 'invalid_request');
  assert.equal((await estimate({render: 'always'})).status, 400);
  assert.equal((await estimate({url: 'https://shop.example.com/'}, {token: 'wrong'})).status, 401);
  void PROJECT;
});

test('status is public, follows the engine and notices, and maintenance pauses the API with a 503 and a link', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let engineDown = false;
  const {app, call, platform} = await platformFor(store, {wrapEngineFetch: fetchImpl => async (url, init) => {
    if (engineDown) throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}});
    return fetchImpl(url, init);
  }});
  const board = platform.board;
  const status = async () => {
    board.view = null;
    const response = await app.inject({method: 'GET', url: '/v1/status'});
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], '*');
    return response.json();
  };
  let view = await status();
  assert.equal(view.status, 'operational');
  assert.deepEqual(view.components.map(c => [c.id, c.status]), [['api', 'operational'], ['fetching', 'operational'], ['console', 'operational']]);
  assert.equal(view.api.version, API_VERSION);
  assert.equal(view.links.status_page, 'https://fetchx.ai/status');

  engineDown = true;
  board.engineState = null;
  view = await status();
  assert.equal(view.status, 'major_outage');
  assert.equal(view.components.find(c => c.id === 'fetching').status, 'major_outage');
  engineDown = false;
  board.engineState = null;

  // An incident marks its components; scheduled maintenance pauses nothing yet.
  const incident = await board.create({kind: 'incident', title: 'Slow browser pages', impact: 'minor', components: ['fetching']}, 'ops@example.com');
  const later = await board.create({kind: 'maintenance', title: 'Upgrade', pause_api: true,
    starts_at: new Date(Date.now() + 3_600_000).toISOString()}, 'ops@example.com');
  view = await status();
  assert.equal(view.status, 'degraded');
  assert.deepEqual(view.notices.map(n => [n.title, n.status]), [['Slow browser pages', 'active'], ['Upgrade', 'scheduled']]);
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/'}})).status, 200, 'not paused yet');
  await board.resolve(incident.id, {update: 'Fixed.'}, 'ops@example.com');
  await board.resolve(later.id, {}, 'ops@example.com');

  // Maintenance that pauses the API: 503 with Retry-After and the status link, before any key check.
  const pause = await board.create({kind: 'maintenance', title: 'Database upgrade', pause_api: true,
    ends_at: new Date(Date.now() + 600_000).toISOString()}, 'ops@example.com');
  for (const [method, url, token] of [['POST', '/v1/fetch', undefined], ['GET', '/v1/balance', undefined], ['POST', '/v1/fetch', 'wrong'],
    ['GET', '/v1/nope', undefined]]) {
    const response = await call(method, url, {...(token ? {token} : {}), ...(method === 'POST' ? {body: {url: 'https://shop.example.com/'}} : {})});
    assert.equal(response.status, 503, `${method} ${url}`);
    assert.equal(response.body.error.code, 'maintenance');
    assert.equal(response.body.error.details.status_url, 'https://fetchx.ai/status');
    assert.equal(response.body.error.details.title, 'Database upgrade');
    assert.ok(Number(response.headers['retry-after']) >= 590 && Number(response.headers['retry-after']) <= 600);
  }
  view = await status();
  assert.equal(view.status, 'maintenance');
  assert.equal(view.components.find(c => c.id === 'api').status, 'maintenance');
  assert.equal(view.components.find(c => c.id === 'console').status, 'operational');
  await board.resolve(pause.id, {update: 'Done.'}, 'ops@example.com');
  assert.equal((await call('GET', '/v1/balance')).status, 200, 'resolving ends the pause at once');
  view = await status();
  assert.equal(view.status, 'operational');
  assert.ok(view.notices.every(n => n.status === 'resolved'), 'resolved notices stay listed for 14 days');
});

test('retired routes answer 410 with their replacement, unknown routes 404 with links, deprecated routes carry headers', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call} = await platformFor(store);
  let response = await call('GET', '/v2/fetch/abc');
  assert.equal(response.status, 410);
  assert.equal(response.body.error.code, 'route_retired');
  assert.equal(response.body.error.details.replacement, 'POST /v1/fetch');
  assert.equal(response.body.error.details.retired_in, '1.0.0');
  assert.equal(response.body.error.details.changelog_url, 'https://fetchx.ai/changelog');
  assert.equal((await call('POST', '/v1/workflows/w1/close', {body: {}})).status, 410);
  assert.equal((await call('GET', '/v2')).status, 410);
  for (const [method, url] of [['GET', '/v1/nope'], ['PUT', '/v1/fetch'], ['GET', '/v1/workflowsx'], ['GET', '/v3/fetch']]) {
    response = await call(method, url, method === 'PUT' ? {body: {}} : {});
    assert.equal(response.status, 404, `${method} ${url}`);
    assert.equal(response.body.error.code, 'route_not_found');
    assert.equal(response.body.error.details.docs_url, 'https://fetchx.ai/docs');
    assert.equal(response.body.error.details.status_url, 'https://fetchx.ai/status');
    assert.equal(response.body.error.details.api_version, API_VERSION);
  }
  assert.equal((await call('GET', '/v1/fetch/00000000-0000-4000-8000-000000000000')).body.error.code, 'not_found', 'a missing request is still not_found');

  changelog.deprecations.push({path: '/v1/usage', method: 'GET', deprecated_in: '1.4.0', deprecated_on: '2026-11-21', sunset_on: '2027-01-01',
    replacement: 'GET /v1/balance'});
  t.after(() => changelog.deprecations.pop());
  response = await call('GET', '/v1/usage');
  assert.equal(response.status, 200);
  assert.equal(response.headers.deprecation, `@${Date.parse('2026-11-21T00:00:00Z') / 1000}`);
  assert.equal(response.headers.sunset, 'Fri, 01 Jan 2027 00:00:00 GMT');
  assert.equal(response.headers.link, '<https://fetchx.ai/changelog>; rel="deprecation"; type="text/html"');
  assert.equal((await call('GET', '/v1/balance')).headers.deprecation, undefined);
});

test('the changelog is consistent: versions, dates, deprecations with notice, retired paths that nothing serves', () => {
  assert.equal(spec.info.version, API_VERSION, 'docs/openapi.json info.version is the newest changelog release');
  const semver = value => value.split('.').map(Number);
  const newer = (a, b) => { const [x, y] = [semver(a), semver(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  const versions = changelog.releases.map(release => release.version);
  for (const [i, release] of changelog.releases.entries()) {
    assert.match(release.version, /^\d+\.\d+\.\d+$/);
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(release.title && release.changes.length, release.version);
    for (const change of release.changes) assert.ok(['added', 'changed', 'deprecated', 'removed', 'fixed', 'security'].includes(change.type), change.text);
    if (i) {
      assert.ok(newer(versions[i - 1], release.version) > 0, `${versions[i - 1]} after ${release.version}`);
      assert.ok(changelog.releases[i - 1].date >= release.date);
    }
  }
  const day = value => Date.parse(`${value}T00:00:00Z`);
  for (const entry of changelog.deprecations) {
    assert.match(entry.path, /^\/v1\//);
    assert.ok(versions.includes(entry.deprecated_in), entry.path);
    assert.ok(entry.replacement && entry.sunset_on && day(entry.sunset_on) - day(entry.deprecated_on) >= changelog.policy.notice_days * 86_400_000,
      `${entry.path} gives at least ${changelog.policy.notice_days} days' notice`);
  }
  const served = Object.keys(spec.paths);
  for (const entry of changelog.retired) {
    assert.ok(['prefix', 'exact'].includes(entry.match) && versions.includes(entry.retired_in) && entry.replacement, entry.path);
    assert.ok(served.every(path => path !== entry.path && !path.startsWith(entry.path + '/')), `${entry.path} is not served`);
  }
});
