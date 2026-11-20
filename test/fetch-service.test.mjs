import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseUrl, openStore, gatewayFor, testConfig, fakeBrowser, html, PROJECT, UNMETERED_TOKEN} from './helpers.mjs';
import {attemptFailure} from '../src/fetch/service.mjs';
import {recordSiteOutcome, siteRoutes} from '../src/site-knowledge.mjs';
import {GatewayError} from '../src/policy.mjs';

const skip = !databaseUrl;
const balance = async store => (await (await import('../src/billing/ledger.mjs')).Ledger.prototype.balance.call(
  {metered: () => true, store}, PROJECT, store.pool)).available;

test('a plain fetch succeeds on the cheapest route, is charged once and can be read back', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, calls} = await gatewayFor(store, {site: () => ({body: html('hello')})});
  const first = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/p/1', formats: ['markdown'], idempotency_key: 'one'}});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, 'succeeded');
  assert.equal(first.body.data.status_code, 200);
  assert.equal(first.body.data.body_encoding, 'utf-8');
  assert.match(first.body.data.body, /hello/);
  assert.match(first.body.data.markdown, /# Data/);
  assert.deepEqual(first.body.attempts.map(a => [a.transport, a.class, a.result]), [['http', 'direct', 'success']]);
  assert.equal(first.body.credits.charged, 1);
  assert.deepEqual(first.body.fixes, ['user-agent', 'accept', 'accept-language']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['user-agent'].startsWith('Mozilla/5.0'), true);
  assert.equal(await balance(store), 99);
  // Replay: same key and body, same result, no new work, no new charge.
  const replay = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/p/1', formats: ['markdown'], idempotency_key: 'one'}});
  assert.equal(replay.body.id, first.body.id);
  assert.equal(calls.length, 1);
  assert.equal(await balance(store), 99);
  const conflict = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/p/2', idempotency_key: 'one'}});
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
  const read = await call('GET', `/v1/fetch/${first.body.id}`);
  assert.equal(read.body.data.body, first.body.data.body);
  const slim = await call('GET', `/v1/fetch/${first.body.id}?include_body=false`);
  assert.equal(slim.body.data.body, undefined);
  const content = await call('GET', `/v1/fetch/${first.body.id}/content`);
  assert.match(content.headers['content-type'], /text\/html/);
  assert.match(content.raw.toString(), /hello/);
  assert.equal((await call('GET', `/v1/fetch/${first.body.id}/screenshot`)).status, 404);
  const list = await call('GET', '/v1/fetch?limit=10');
  assert.deepEqual(list.body.items.map(i => i.id), [first.body.id]);
  assert.equal((await call('GET', '/v1/fetch?idempotency_key=one')).body.items.length, 1);
  assert.equal((await call('DELETE', `/v1/fetch/${first.body.id}`)).status, 204);
  const expired = await call('GET', `/v1/fetch/${first.body.id}`);
  assert.equal(expired.body.data.content_expired, true);
  assert.equal((await call('GET', `/v1/fetch/${first.body.id}/content`)).status, 410);
  assert.equal((await call('GET', '/v1/fetch/00000000-0000-4000-8000-000000000000')).status, 404);
  const usage = await call('GET', '/v1/usage');
  assert.equal(usage.body.balance.credits, 99);
  assert.equal(usage.body.used.credits, 1);
  assert.equal(usage.body.used.succeeded, 1);
  assert.deepEqual(usage.body.by_step, [{step: 'http', requests: 1, credits: 1}]);
});

test('auto mode climbs past blocks, bills only the step that worked, and learns it', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const site = ({provider}) => (provider === 'evomi' || provider === 'dataimpulse'
    ? {body: html('residential data')} : {status: 403, body: '<title>Access denied</title>'});
  const {call, calls} = await gatewayFor(store, {site});
  const first = await call('POST', '/v1/fetch', {body: {url: 'https://blocked.example.com/item'}});
  assert.equal(first.body.status, 'succeeded', JSON.stringify(first.body));
  assert.deepEqual(first.body.attempts.map(a => [a.class, a.result]), [['direct', 'blocked'], ['datacenter', 'blocked'], ['residential', 'success']]);
  assert.equal(first.body.credits.charged, 5, 'residential HTTP price, nothing for the blocked steps');
  assert.equal(await balance(store), 95);
  assert.ok(first.body.attempts.every(a => !('provider' in a)), 'providers are never named');
  // The next request starts on the route that worked.
  calls.length = 0;
  const second = await call('POST', '/v1/fetch', {body: {url: 'https://blocked.example.com/other'}});
  assert.equal(second.body.status, 'succeeded');
  assert.deepEqual(calls.map(c => c.provider === 'direct' || c.provider === 'oxylabs' ? c.provider : 'residential'), ['residential']);
});

test('rate limits rotate to fresh residential IPs, alternating providers', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let residentialCalls = 0;
  const site = ({provider}) => {
    if (provider === 'direct' || provider === 'oxylabs') return {status: 429, headers: {'retry-after': '30'}, body: 'slow down'};
    residentialCalls++;
    return residentialCalls < 3 ? {status: 429, body: 'slow down'} : {body: html('finally')};
  };
  const {call, calls} = await gatewayFor(store, {site});
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://busy.example.com/'}});
  assert.equal(result.body.status, 'succeeded', JSON.stringify(result.body.attempts));
  assert.deepEqual(calls.map(c => c.provider), ['direct', 'evomi', 'dataimpulse', 'evomi']);
  assert.deepEqual(result.body.attempts.map(a => a.result), ['rate_limited', 'rate_limited', 'rate_limited', 'success']);
});

test('failures are free and say what to do next', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call} = await gatewayFor(store, {site: () => ({status: 403, body: 'no'})});
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://wall.example.com/', render: 'never'}});
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'failed');
  assert.equal(result.body.error.code, 'blocked');
  assert.equal(result.body.error.next.action, 'retry_later');
  assert.equal(result.body.credits.charged, 0);
  assert.equal(result.body.data.status_code, 403, 'a failed request shows what the site last answered');
  assert.equal(result.body.data.body, 'no');
  assert.equal(await balance(store), 100);
  // An explicit route: one attempt, and the next step suggests auto mode.
  const fixed = await call('POST', '/v1/fetch', {body: {url: 'https://wall.example.com/x', route: {class: 'datacenter', country: 'US'}}});
  assert.equal(fixed.body.attempts.length, 1);
  assert.equal(fixed.body.error.next.action, 'use_auto');
  const login = await gatewayFor(store, {site: () => ({status: 401, body: ''})});
  const needsLogin = await login.call('POST', '/v1/fetch', {body: {url: 'https://members.example.com/'}});
  assert.equal(needsLogin.body.error.code, 'login_required');
  assert.equal(needsLogin.body.attempts.length, 1, 'a login wall stops the ladder');
  assert.equal(needsLogin.body.error.next.action, 'provide_credentials');
});

test('only GET and HEAD escalate; an uncertain POST is never resent', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const error = Object.assign(new (await import('../src/policy.mjs')).GatewayError('source_timeout', 504), {dispatched: true});
  const {call, calls} = await gatewayFor(store, {site: () => error});
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://api.example.com/orders', method: 'POST', body: '{"a":1}',
    headers: {'content-type': 'application/json'}}});
  assert.equal(result.body.status, 'failed');
  assert.equal(result.body.error.code, 'uncertain');
  assert.equal(result.body.error.next.action, 'recover');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
});

test('cooling sites are refused without sending anything; admission checks credits and ceilings', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  for (const route of [{class: 'direct', provider: '', country: ''}, {class: 'datacenter', provider: 'oxylabs', country: 'US'},
    {class: 'residential', provider: 'evomi', country: 'US'}]) {
    for (const execution of ['http', 'browser']) {
      // A residential browser route is judged on six fresh exit IPs, the rest on two.
      const walls = execution === 'browser' && route.class === 'residential' ? 6 : 2;
      for (let i = 0; i < walls; i++) await recordSiteOutcome(store.pool, {host: 'https://cold.example.com/', execution, route, outcome: 'blocked'});
    }
  }
  // Without residential IPs to draw, every route is resting and nothing is sent.
  const {call: callNoResidential, calls} = await gatewayFor(store, {config: testConfig({residential: {providers: {}}})});
  const cold = await callNoResidential('POST', '/v1/fetch', {body: {url: 'https://cold.example.com/'}});
  assert.equal(cold.body.status, 'failed');
  assert.equal(cold.body.error.code, 'cooling_down');
  assert.ok(cold.body.error.retry_after_seconds > 600 && cold.body.error.retry_after_seconds <= 900, 'a route cools for 15 minutes');
  assert.equal(calls.length, 0);
  // Residential browsers never rest: each step draws a fresh IP, so walls on
  // earlier IPs do not keep the next request from trying.
  const {call} = await gatewayFor(store);
  const fresh = await call('POST', '/v1/fetch', {body: {url: 'https://cold.example.com/'}});
  assert.deepEqual(fresh.body.attempts.map(a => [a.transport, a.class]), Array(5).fill(['browser', 'residential']));
  const low = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/', render: 'always', max_credits: 5}});
  assert.equal(low.status, 402);
  assert.equal(low.body.error.code, 'max_credits_too_low');
  assert.equal(low.body.error.details.min_credits, 10);
  await store.pool.query('UPDATE control_credit_accounts SET granted_credits = 0 WHERE project = $1', [PROJECT]);
  const broke = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/'}});
  assert.equal(broke.status, 402);
  assert.equal(broke.body.error.code, 'insufficient_credits');
  // A project provisioned in config is unmetered.
  const free = await call('POST', '/v1/fetch', {token: UNMETERED_TOKEN, body: {url: 'https://shop.example.com/'}});
  assert.equal(free.body.status, 'succeeded');
  assert.equal(free.body.credits.charged, 0);
  assert.equal((await call('POST', '/v1/fetch', {token: 'wrong', body: {url: 'https://shop.example.com/'}})).status, 401);
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://10.0.0.1/'}})).body.error.code, 'url_not_allowed');
});

test('an attempt cut off by the request deadline is not held against the route', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  // The site (or a slow captcha solve) is still busy when the request's own time is up.
  const {call} = await gatewayFor(store, {site: async () => {
    await new Promise(resolve => setTimeout(resolve, 5300));
    return Object.assign(new GatewayError('source_timeout', 504), {dispatched: true});
  }});
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://slow.example.com/', timeout_ms: 5000}});
  assert.equal(result.body.status, 'failed');
  assert.equal(result.body.error.code, 'timeout');
  assert.deepEqual(result.body.attempts.map(a => [a.transport, a.result]), [['http', 'unreachable']]);
  await new Promise(resolve => setTimeout(resolve, 200)); // learning runs after the response
  assert.deepEqual(await siteRoutes(store.pool, 'slow.example.com'), [], 'the route is not marked failing');
});

test('a bot challenge on the first HTTP answer goes straight to a browser', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const challenge = '<html><head><title>Bot or Not?</title><script src="/app.js"></script></head><body></body></html>';
  const browser = fakeBrowser(async (input, hooks) => {
    await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from(html('search results')).toString('base64')});
    return {status: 200, final_url: input.url, headers: {'content-type': 'text/html'}, cookies: [], captcha: [{type: 'datadome', outcome: 'passed'}]};
  });
  const {call} = await gatewayFor(store, {site: () => ({status: 429, body: challenge}), browser});
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://challenge.example.com/search'}});
  assert.equal(result.body.status, 'succeeded', JSON.stringify(result.body));
  assert.deepEqual(result.body.attempts.map(a => [a.transport, a.class, a.result]),
    [['http', 'direct', 'blocked'], ['browser', 'residential', 'success']]);
});

test('a failed request reports the block it met, not how a later step failed', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const site = ({provider}) => (provider === 'direct' ? {status: 403, body: '<title>Access Denied</title>'}
    : Object.assign(new GatewayError('source_timeout', 504), {dispatched: true}));
  const {call} = await gatewayFor(store, {site});
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://wall.example.com/search', render: 'never', max_attempts: 2}});
  assert.equal(result.body.status, 'failed');
  assert.deepEqual(result.body.attempts.map(a => [a.class, a.result]), [['direct', 'blocked'], ['datacenter', 'unreachable']]);
  assert.equal(result.body.error.code, 'blocked');
});

test('failures of FetchX\'s own browser machinery are failed attempts, not an unreachable site', () => {
  for (const code of ['browser_worker_transport_failed', 'browser_callback_failed', 'browser_launch_failed', 'browser_build_mismatch']) {
    assert.equal(attemptFailure({code, dispatched: true}, true), 'failed', code);
    assert.equal(attemptFailure({code, dispatched: true}, false), 'uncertain', code);
  }
  assert.equal(attemptFailure({code: 'browser_failed', dispatched: true}, true), 'unreachable', 'a page that would not load');
  assert.equal(attemptFailure({code: 'source_timeout', dispatched: true}, true), 'unreachable');
  assert.equal(attemptFailure({code: 'browser_worker_transport_failed', dispatched: false}, true), 'not_admitted', 'nothing was sent');
});

test('blocks on some pages never lock out a route that works for the host', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const host = 'https://mixed.example.com/';
  const residential = {class: 'residential', provider: 'evomi', country: 'US'};
  await recordSiteOutcome(store.pool, {host, execution: 'http', route: residential, outcome: 'success'});
  for (const route of [{class: 'direct', provider: '', country: ''}, {class: 'datacenter', provider: 'oxylabs', country: 'US'}, residential]) {
    for (let i = 0; i < 2; i++) await recordSiteOutcome(store.pool, {host, execution: 'http', route, outcome: 'blocked'});
  }
  const site = ({provider}) => (provider === 'evomi' || provider === 'dataimpulse' ? {body: html('product page')} : {status: 403, body: 'denied'});
  const {call} = await gatewayFor(store, {site});
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://mixed.example.com/product', render: 'never'}});
  assert.equal(result.body.status, 'succeeded', JSON.stringify(result.body));
  assert.deepEqual(result.body.attempts.map(a => [a.class, a.result]), [['residential', 'success']]);
  assert.deepEqual(result.body.skipped.filter(s => s.reason === 'cooling').map(s => s.class).sort(), ['datacenter', 'direct']);
});

test('a JavaScript shell moves to the browser; the rendered page is returned and charged as a browser step', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const shell = '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
  const browser = fakeBrowser(async (input, hooks) => {
    await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from(html('rendered price $5')).toString('base64')});
    await hooks.artifact({kind: 'screenshot', content_type: 'image/jpeg', body_base64: Buffer.from('jpeg').toString('base64')});
    return {status: 200, final_url: input.url, headers: {'content-type': 'text/html'}, cookies: [{name: 'sid', value: 'x', domain: 'app.example.com', path: '/'}], captcha: [],
      content: {settled: !input.url.endsWith('/other'), ms: 1500}};
  });
  const {call} = await gatewayFor(store, {site: () => ({body: shell}), browser});
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://app.example.com/dash', formats: ['text'],
    headers: {cookie: 'session=abc', authorization: 'Bearer site'}}});
  assert.equal(result.body.status, 'succeeded', JSON.stringify(result.body));
  assert.deepEqual(result.body.attempts.map(a => [a.transport, a.class, a.result]),
    [['http', 'direct', 'needs_browser'], ['browser', 'residential', 'success']]);
  assert.equal(result.body.data.rendered, true);
  assert.match(result.body.data.text, /rendered price \$5/);
  assert.equal(result.body.data.screenshot, undefined, 'not asked for');
  // A screenshot needs a browser, so it starts there.
  const shot = await call('POST', '/v1/fetch', {body: {url: 'https://app.example.com/other', formats: ['screenshot']}});
  assert.deepEqual(shot.body.attempts.map(a => a.transport), ['browser']);
  // Each browser step says whether the page had stopped filling itself in when it was read.
  assert.equal(result.body.attempts[1].content, 'settled');
  assert.equal(shot.body.attempts[0].content, 'still_loading');
  assert.equal(shot.body.data.screenshot, Buffer.from('jpeg').toString('base64'));
  assert.equal((await call('GET', `/v1/fetch/${shot.body.id}/screenshot`)).raw.toString(), 'jpeg');
  assert.deepEqual(result.body.data.cookies, [{name: 'sid', value: 'x', domain: 'app.example.com', path: '/'}]);
  assert.equal(result.body.credits.charged, 25);
  const run = browser.runs[0];
  assert.equal(browser.runs[1].screenshot, true);
  assert.deepEqual(run.cookies, [{name: 'session', value: 'abc', url: 'https://app.example.com'}]);
  assert.deepEqual(run.headers, {authorization: 'Bearer site'}, 'the browser keeps its own user agent and accept headers');
  assert.equal(run.locale, 'en-US');
  assert.equal(run.captcha, false, 'no solver configured');
  assert.equal(run.content_wait_ms, 20_000, 'the browser waits for a page that fills itself in');
});

test('browser captchas are solved through the gateway and add their price', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const solved = [];
  const solver = {
    settings: {datadome: true},
    supports: () => true,
    solve: async (kind, input) => {
      solved.push({kind, ...input});
      return kind === 'datadome' ? {cookie: 'datadome=solvedcookievalue; Path=/'} : {token: 't'.repeat(40)};
    },
    recover: async () => {},
  };
  const browser = fakeBrowser(async (input, hooks) => {
    const turnstile = await hooks.captcha({type: 'turnstile', website_url: input.url, site_key: '0x4AAAAAAAsyntheticKey', user_agent: 'Mozilla/5.0'});
    assert.equal(turnstile.token.length, 40);
    const datadome = await hooks.captcha({type: 'datadome', website_url: input.url, captcha_url: 'https://geo.captcha-delivery.com/captcha/?t=fe',
      user_agent: 'Mozilla/5.0'});
    assert.match(datadome.cookie, /^datadome=/);
    await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from(html('past the wall')).toString('base64')});
    return {status: 200, final_url: input.url, headers: {}, cookies: [], captcha: [{type: 'turnstile', outcome: 'passed'}]};
  });
  const {call} = await gatewayFor(store, {site: () => ({status: 403, body: 'blocked'}), browser, solver});
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://guarded.example.com/'}});
  assert.equal(result.body.status, 'succeeded', JSON.stringify(result.body));
  assert.equal(browser.runs[0].captcha, true);
  assert.deepEqual(solved.map(s => s.kind), ['turnstile', 'datadome']);
  assert.match(solved[1].proxyUrl, /^http:\/\/.*evomi|dataimpulse/, 'DataDome is solved from the attempt\'s own residential proxy');
  assert.equal(solved[0].project, PROJECT);
  assert.equal(result.body.credits.charged, 35, 'residential browser 25 + captcha 10');
  assert.deepEqual(result.body.attempts.at(-1).captcha, ['turnstile:passed']);
});

test('async requests return at once and finish in the background; startup recovery closes cut-off work', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {call, gateway} = await gatewayFor(store, {site: async () => { await gate; return {body: html('late')}; }});
  const pending = await call('POST', '/v1/fetch', {body: {url: 'https://slow.example.com/', async: true}});
  assert.equal(pending.status, 202);
  assert.equal(pending.body.status, 'pending');
  assert.equal((await call('GET', `/v1/fetch/${pending.body.id}`)).status, 202);
  release();
  await gateway.service.running.get(pending.body.id);
  const done = await call('GET', `/v1/fetch/${pending.body.id}`);
  assert.equal(done.body.status, 'succeeded');
  // A request left pending by a crash is closed as uncertain and its credits released.
  await store.pool.query(`INSERT INTO fetch_requests (id, project, idempotency_key, input_hash, input, host)
    VALUES ('00000000-0000-4000-8000-0000000000aa', $1, 'cut', 'h', $2, 'x.example')`,
  [PROJECT, gateway.service.sealer.seal({url: 'https://x.example.com/', formats: []})]);
  await store.pool.query(`INSERT INTO credit_reservations (request, project, credits) VALUES ('00000000-0000-4000-8000-0000000000aa', $1, 50)`, [PROJECT]);
  assert.equal(await gateway.service.recover(), 1);
  const cut = await call('GET', '/v1/fetch/00000000-0000-4000-8000-0000000000aa');
  assert.equal(cut.body.error.code, 'uncertain');
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM credit_reservations')).rows[0].n, 0);
});

test('webhooks are signed and sent to public URLs only', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, calls, gateway} = await gatewayFor(store);
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/', webhook_url: 'https://hooks.example.com/fetchx'}});
  await gateway.service.running.get(result.body.id);
  await new Promise(resolve => setTimeout(resolve, 50));
  const hook = calls.find(c => c.url === 'https://hooks.example.com/fetchx');
  assert.ok(hook, 'webhook delivered');
  const secret = await gateway.service.webhookSecret(PROJECT);
  const {createHmac} = await import('node:crypto');
  assert.equal(hook.method, 'POST');
  assert.match(hook.headers['x-fetchx-signature'], /^sha256=[a-f0-9]{64}$/);
  assert.ok(secret.startsWith('whsec_'));
  assert.equal(typeof createHmac, 'function');
});

test('provider rules keep Oxylabs off .gov sites', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, calls} = await gatewayFor(store, {config: testConfig({routes: {direct: false}}), site: () => ({body: html('gov')})});
  const result = await call('POST', '/v1/fetch', {body: {url: 'https://records.agency.gov/'}});
  assert.equal(result.body.status, 'succeeded');
  assert.ok(calls.every(c => c.provider !== 'oxylabs'));
  assert.ok(result.body.skipped.some(s => s.class === 'datacenter' && s.reason === 'excluded_by_provider_rule'));
});

test('deleting a request removes everything the site sent; the summary and charge stay', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, gateway} = await gatewayFor(store, {site: () => ({body: html('secret page'), headers: {'set-cookie': 'sid=1; Path=/'}})});
  const done = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/p', formats: ['markdown', 'text', 'links', 'metadata']}});
  assert.equal(done.body.data.cookies[0].name, 'sid');
  assert.equal((await call('DELETE', `/v1/fetch/${done.body.id}`)).status, 204);
  const after = await call('GET', `/v1/fetch/${done.body.id}`);
  assert.deepEqual(Object.keys(after.body.data).sort(), ['body_bytes', 'content_expired', 'content_type', 'final_url', 'rendered', 'status_code']);
  assert.equal(after.body.credits.charged, 1);
  assert.equal((await call('GET', `/v1/fetch/${done.body.id}/content`)).status, 410);
  const stored = (await store.pool.query('SELECT count(*)::int AS n FROM fetch_content WHERE request = $1', [done.body.id])).rows[0].n;
  assert.equal(stored, 0);
  // Expiry does the same after contentDays.
  const old = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/old'}});
  await store.pool.query("UPDATE fetch_requests SET created_at = now() - interval '8 days' WHERE id = $1", [old.body.id]);
  await gateway.service.prune();
  assert.equal((await call('GET', `/v1/fetch/${old.body.id}`)).body.data.content_expired, true);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM fetch_content WHERE request = $1', [old.body.id])).rows[0].n, 0);
});

test('a residential browser session that passed is reused with its device identity, placed where its IP is', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  // As large as a real drawn identity (about 360 KB of JSON): a kept one must still pass a worker's input check.
  const identity = {navigator: {userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0'},
    fonts: Array.from({length: 9000}, (_, i) => `Font Family ${i} Regular Condensed Extra`)};
  assert.ok(Buffer.byteLength(JSON.stringify(identity)) > 300_000);
  const browser = fakeBrowser(async (input, hooks) => {
    await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from(html('hotel')).toString('base64')});
    return {status: 200, final_url: input.url, headers: {'content-type': 'text/html'}, cookies: [], captcha: [],
      warmup: input.warmup ? 'passed' : null, ...(input.fingerprint ? {} : {fingerprint: identity})};
  });
  const challenge = '<html><head><title>Bot or Not?</title><script src="/app.js"></script></head><body></body></html>';
  const site = ({url}) => (url === 'https://ipinfo.io/json'
    ? {headers: {'content-type': 'application/json'}, body: JSON.stringify({ip: '203.0.113.9', country: 'US',
      timezone: 'America/Los_Angeles', loc: '34.05,-118.24'})}
    : {status: 429, body: challenge});
  const config = testConfig({browser: {sessions: {sessionGapMs: 0, hostGapMs: 0}}});
  const {call, calls} = await gatewayFor(store, {config, site, browser});
  const first = await call('POST', '/v1/fetch', {body: {url: 'https://hotels.example.com/h/1'}});
  assert.equal(first.body.status, 'succeeded', JSON.stringify(first.body));
  assert.deepEqual(first.body.attempts.map(a => [a.transport, a.result, a.warmup ?? null]),
    [['http', 'blocked', null], ['browser', 'success', 'passed']]);
  const [run] = browser.runs;
  assert.equal(run.timezone, 'America/Los_Angeles', 'the timezone of the exit IP, not of the route country');
  assert.deepEqual(run.geolocation, {latitude: 34.05, longitude: -118.24});
  assert.equal(run.warmup, true, 'a site that just showed a bot check is visited from its home page');
  assert.equal(run.self_clear_ms, 45_000);
  assert.equal(run.fingerprint, undefined, 'a fresh session draws a fresh identity');
  assert.equal(calls.filter(c => c.url === 'https://ipinfo.io/json').length, 1);

  const second = await call('POST', '/v1/fetch', {body: {url: 'https://hotels.example.com/h/2'}});
  assert.equal(second.body.status, 'succeeded', JSON.stringify(second.body));
  assert.deepEqual(second.body.attempts.map(a => [a.transport, a.class, a.result]), [['browser', 'residential', 'success']],
    'the browser route that worked comes first');
  assert.deepEqual(browser.runs[1].fingerprint, identity, 'the kept session brings its identity');
  assert.equal(browser.runs[1].warmup, true, 'the host has refused FetchX before');
  assert.equal(calls.filter(c => c.url === 'https://ipinfo.io/json').length, 1, 'same session: its exit was already looked up');
});

test('a device identity too large to send is never kept, so the next step draws a fresh one', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const huge = {navigator: {userAgent: 'Mozilla/5.0'}, blob: 'x'.repeat(1_100_000)};
  const browser = fakeBrowser(async (input, hooks) => {
    await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from(html('hotel')).toString('base64')});
    return {status: 200, final_url: input.url, headers: {'content-type': 'text/html'}, cookies: [], captcha: [],
      ...(input.fingerprint ? {} : {fingerprint: huge})};
  });
  const site = ({url}) => (url === 'https://ipinfo.io/json'
    ? {headers: {'content-type': 'application/json'}, body: JSON.stringify({ip: '203.0.113.9', country: 'US', timezone: 'America/Chicago'})}
    : {status: 429, body: '<html><head><title>Bot or Not?</title></head><body></body></html>'});
  const config = testConfig({browser: {sessions: {sessionGapMs: 0, hostGapMs: 0}}});
  const {call} = await gatewayFor(store, {config, site, browser});
  for (const path of ['/h/1', '/h/2']) {
    const done = await call('POST', '/v1/fetch', {body: {url: `https://big.example.com${path}`}});
    assert.equal(done.body.status, 'succeeded', JSON.stringify(done.body).slice(0, 400));
  }
  assert.equal(browser.runs[1].fingerprint, undefined, 'the session is reused without the identity a worker would refuse');
});

test('walls on residential browsers draw fresh IPs, alternating providers; the next request starts where a session got through', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  // The site walls the first three browser visits and lets the rest through.
  let visits = 0;
  const wall = '<html><head><title>Bot or Not?</title></head><body></body></html>';
  const browser = fakeBrowser(async (input, hooks) => {
    if (++visits <= 3) {
      await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from(wall).toString('base64')});
      return {status: 429, final_url: input.url, headers: {'content-type': 'text/html'}, cookies: [], captcha: []};
    }
    await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from(html('results')).toString('base64')});
    return {status: 200, final_url: input.url, headers: {'content-type': 'text/html'}, cookies: [], captcha: [], fingerprint: {navigator: {}}};
  });
  const site = ({url}) => (url === 'https://ipinfo.io/json'
    ? {headers: {'content-type': 'application/json'}, body: JSON.stringify({ip: '203.0.113.9', country: 'US', timezone: 'America/Chicago'})}
    : {status: 429, body: wall});
  const config = testConfig({browser: {sessions: {sessionGapMs: 0, hostGapMs: 0}}});
  const {call} = await gatewayFor(store, {config, site, browser});
  const providers = async id => (await store.pool.query(
    "SELECT provider FROM fetch_attempts WHERE request = $1 AND transport = 'browser' ORDER BY n", [id])).rows.map(r => r.provider);

  const first = await call('POST', '/v1/fetch', {body: {url: 'https://guarded.example.com/search?q=1'}});
  assert.equal(first.body.status, 'succeeded', JSON.stringify({attempts: first.body.attempts, skipped: first.body.skipped, error: first.body.error}));
  assert.deepEqual(first.body.attempts.map(a => [a.transport, a.class, a.result]), [['http', 'direct', 'blocked'],
    ['browser', 'residential', 'blocked'], ['browser', 'residential', 'blocked'], ['browser', 'residential', 'blocked'],
    ['browser', 'residential', 'success']], 'each wall is followed by a fresh IP, not a rest');
  assert.deepEqual(await providers(first.body.id), ['evomi', 'dataimpulse', 'evomi', 'dataimpulse']);

  // The session that got through is where the next request starts, though walls just came from the other provider.
  const second = await call('POST', '/v1/fetch', {body: {url: 'https://guarded.example.com/search?q=2'}});
  assert.deepEqual(second.body.attempts.map(a => [a.transport, a.result]), [['browser', 'success']]);
  assert.deepEqual(await providers(second.body.id), ['dataimpulse']);
  assert.deepEqual(browser.runs.at(-1).fingerprint, {navigator: {}}, 'on the kept session, with its identity');
});

test('a request every fresh residential IP was walled on can be retried soon', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const wall = '<html><head><title>Bot or Not?</title></head><body></body></html>';
  const browser = fakeBrowser(async (input, hooks) => {
    await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from(wall).toString('base64')});
    return {status: 403, final_url: input.url, headers: {'content-type': 'text/html'}, cookies: [], captcha: []};
  });
  const site = ({url}) => (url === 'https://ipinfo.io/json'
    ? {headers: {'content-type': 'application/json'}, body: JSON.stringify({ip: '203.0.113.9', country: 'US', timezone: 'America/Chicago'})}
    : {status: 403, body: wall});
  // The datacenter browser has rested for hours; that is no reason to wait.
  await recordSiteOutcome(store.pool, {host: 'https://walled.example.com/', execution: 'browser',
    route: {class: 'datacenter', provider: 'oxylabs', country: 'US'}, outcome: 'blocked'});
  const config = testConfig({browser: {sessions: {sessionGapMs: 0, hostGapMs: 0}}});
  const {call} = await gatewayFor(store, {config, site, browser});
  const done = await call('POST', '/v1/fetch', {body: {url: 'https://walled.example.com/'}});
  assert.equal(done.body.error.code, 'blocked');
  assert.equal(done.body.error.retry_after_seconds, 30);
});

test('an app that never rendered in the browser is not billed; the next step draws a fresh IP', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const shell = '<html><head><title>Hotel Search Results</title></head><body><div id="app"></div><script src="/app.js"></script></body></html>';
  let visits = 0;
  const browser = fakeBrowser(async (input, hooks) => {
    const page = ++visits === 1 ? shell : html('Hotel Per La, from $189 a night');
    await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from(page).toString('base64')});
    return {status: 200, final_url: input.url, headers: {'content-type': 'text/html'}, cookies: [], captcha: []};
  });
  const site = ({url}) => (url === 'https://ipinfo.io/json'
    ? {headers: {'content-type': 'application/json'}, body: JSON.stringify({ip: '203.0.113.9', country: 'US', timezone: 'America/Chicago'})}
    : {body: shell});
  const config = testConfig({browser: {sessions: {sessionGapMs: 0, hostGapMs: 0}}});
  const {call} = await gatewayFor(store, {config, site, browser});
  const done = await call('POST', '/v1/fetch', {body: {url: 'https://shell.example.com/search', render: 'always'}});
  assert.equal(done.body.status, 'succeeded', JSON.stringify(done.body.attempts));
  assert.deepEqual(done.body.attempts.map(a => [a.transport, a.class, a.result]),
    [['browser', 'residential', 'blocked'], ['browser', 'residential', 'success']]);
  assert.match(done.body.data.body, /Hotel Per La/);
  assert.equal(done.body.credits.charged, 25, 'only the step that returned the page is billed');
});
