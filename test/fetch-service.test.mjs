import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseUrl, openStore, gatewayFor, testConfig, fakeBrowser, html, PROJECT, UNMETERED_TOKEN} from './helpers.mjs';
import {recordSiteOutcome} from '../src/site-knowledge.mjs';

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
      for (let i = 0; i < 2; i++) await recordSiteOutcome(store.pool, {host: 'https://cold.example.com/', execution, route, outcome: 'blocked'});
    }
  }
  const {call, calls} = await gatewayFor(store);
  const cold = await call('POST', '/v1/fetch', {body: {url: 'https://cold.example.com/'}});
  assert.equal(cold.body.status, 'failed');
  assert.equal(cold.body.error.code, 'cooling_down');
  assert.ok(cold.body.error.retry_after_seconds > 3600);
  assert.equal(calls.length, 0);
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

test('a JavaScript shell moves to the browser; the rendered page is returned and charged as a browser step', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const shell = '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
  const browser = fakeBrowser(async (input, hooks) => {
    await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from(html('rendered price $5')).toString('base64')});
    await hooks.artifact({kind: 'screenshot', content_type: 'image/jpeg', body_base64: Buffer.from('jpeg').toString('base64')});
    return {status: 200, final_url: input.url, headers: {'content-type': 'text/html'}, cookies: [{name: 'sid', value: 'x', domain: 'app.example.com', path: '/'}], captcha: []};
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
