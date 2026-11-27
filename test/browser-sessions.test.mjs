// Browser sessions on the platform side (src/fetch/browser-sessions.mjs): the
// hold at create, one charge from the engine's receipt (nothing when the
// browser failed or the create's answer was lost), residential traffic, the
// project's limits, reconcile(), and the caller's WebSocket carried to the
// engine without the caller's API key. Uses the fake engine, and a local TCP
// server in place of the engine's upgrade.
import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import {databaseUrl, openStore, platformFor, PROJECT, SERVICE_TOKEN, TOKEN} from './helpers.mjs';

const credits = async (store, value) => store.pool.query('UPDATE control_credit_accounts SET granted_credits = $2 WHERE project = $1', [PROJECT, value]);
const age = (store, id, {overdue = false} = {}) => store.pool.query(`UPDATE fetch_settlements SET created_at = now() - interval '2 minutes'
  ${overdue ? ", deadline = now() - interval '1 second'" : ''} WHERE request = $1`, [id]);

test('a session holds its price, is charged once from its receipt, and costs nothing when its browser failed', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, engine} = await platformFor(store);
  const balance = async () => (await call('GET', '/v1/balance')).body;
  const before = await balance();
  assert.equal(before.credits, 100);

  const plain = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com']}});
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual([plain.body.credits.max, (await balance()).credits], [10, 90]);
  assert.equal(engine.sessions.get(plain.body.id).max_wire_bytes, 500_000_000, 'a datacenter session gets the engine default');
  engine.closeSession(plain.body.id, {reason: 'ttl'});
  const ended = (await call('GET', `/v1/browser-sessions/${plain.body.id}`)).body;
  assert.deepEqual([ended.status, ended.close_reason, ended.error, ended.credits.charged, ended.credits.breakdown.step],
    ['closed', 'ttl', null, 10, 'browser_session']);
  assert.equal((await balance()).credits, 90);
  // Read again, and closed again: charged once.
  assert.equal((await call('DELETE', `/v1/browser-sessions/${plain.body.id}`)).body.credits.charged, 10);
  assert.equal((await balance()).credits, 90);

  const broken = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com']}});
  engine.closeSession(broken.body.id, {reason: 'error', error: 'browser_crashed'});
  const failed = (await call('DELETE', `/v1/browser-sessions/${broken.body.id}`)).body;
  assert.deepEqual([failed.close_reason, failed.error, failed.credits.charged, failed.credits.breakdown], ['error', 'browser_crashed', 0, null]);
  assert.equal((await balance()).credits, 90);

  // Residential: max_credits pays for the price and the traffic past what it
  // includes; the engine closes the session at the traffic that pays for.
  const residential = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com'], route: {class: 'residential'}, max_credits: 60}});
  assert.equal(residential.status, 201, JSON.stringify(residential.body));
  assert.equal(engine.sessions.get(residential.body.id).max_wire_bytes, 12_000_000);
  assert.equal(engine.sessions.get(residential.body.id).route.country, 'US');
  engine.closeSession(residential.body.id, {reason: 'client', wire_bytes: 8_500_000});
  const traffic = (await call('GET', `/v1/browser-sessions/${residential.body.id}`)).body;
  assert.deepEqual([traffic.traffic_mb, traffic.credits.charged, traffic.credits.breakdown],
    [8.5, 45, {step: 'browser_session_residential', step_credits: 25, traffic_mb: 8.5, included_mb: 5, traffic_credits: 20}]);
  assert.equal((await balance()).credits, 45);
  // Without max_credits it holds what the balance allows, and is never charged more.
  const capped = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com'], route: {class: 'residential', country: 'DE'}}});
  assert.deepEqual([capped.body.credits.max, engine.sessions.get(capped.body.id).max_wire_bytes], [45, 9_000_000]);
  engine.closeSession(capped.body.id, {reason: 'traffic_limit', wire_bytes: 50_000_000});
  assert.equal((await call('GET', `/v1/browser-sessions/${capped.body.id}`)).body.credits.charged, 45);
  assert.equal((await balance()).credits, 0);

  const usage = (await call('GET', '/v1/usage')).body;
  assert.deepEqual(usage.by_step, [{step: 'browser_session', requests: 1, credits: 10}, {step: 'browser_session_residential', requests: 2, credits: 90}]);
  assert.deepEqual([usage.used.succeeded, usage.used.failed], [0, 0], 'sessions are not counted as requests');
});

test('admission refuses past the limits and the balance, and an uncertain create is never charged', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let mode = null;
  const {call, engine, platform} = await platformFor(store, {
    wrapEngineFetch: fakeFetch => async (url, init) => {
      if (mode === 'refused') throw Object.assign(new Error('down'), {cause: {code: 'ECONNREFUSED'}});
      if (mode === 'cut') throw Object.assign(new Error('reset'), {cause: {code: 'ECONNRESET'}});
      const response = await fakeFetch(url, init);
      if (mode === 'lost' && init.method === 'POST' && new URL(url).pathname === '/internal/v1/browser-sessions') {
        throw Object.assign(new Error('reset'), {cause: {code: 'ECONNRESET'}});
      }
      return response;
    },
  });
  const pending = async () => (await store.pool.query(`SELECT count(*)::int AS n FROM fetch_settlements WHERE status = 'pending'`)).rows[0].n;
  await credits(store, 9);
  const poor = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com']}});
  assert.deepEqual([poor.status, poor.body.error.code, poor.body.error.details], [402, 'insufficient_credits', {available: 9, needed: 10}]);
  await credits(store, 100);
  const low = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com'], max_credits: 9}});
  assert.deepEqual([low.status, low.body.error.code, low.body.error.details], [402, 'max_credits_too_low', {min_credits: 10}]);
  const unknown = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com'], record_video: true}});
  assert.deepEqual([unknown.status, unknown.body.error.details], [400, {field: 'record_video', reason: 'unknown field'}]);
  assert.equal(await pending(), 0);

  // The same idempotency_key holds once.
  const body = {allow_hosts: ['shop.example.com'], idempotency_key: 'once'};
  const first = await call('POST', '/v1/browser-sessions', {body});
  const again = await call('POST', '/v1/browser-sessions', {body: {...body, secrets: undefined}});
  assert.deepEqual([first.status, again.status, again.body.id], [201, 200, first.body.id]);
  assert.equal((await call('GET', '/v1/balance')).body.credits, 90);

  // An engine that cannot be reached started nothing: nothing is held or kept.
  mode = 'refused';
  const down = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com']}});
  assert.deepEqual([down.status, down.body.error.code, down.headers['retry-after']], [503, 'unavailable', '30']);
  assert.equal(await pending(), 1);

  // An answer lost after the engine got the create: the session may be open,
  // so it is closed, and settled by reconcile() without a charge.
  mode = 'lost';
  const lost = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['lost.example.com']}});
  mode = null;
  assert.deepEqual([lost.status, lost.body.error.code], [503, 'unavailable']);
  const row = (await store.pool.query(`SELECT request FROM fetch_settlements WHERE error_code = 'create_uncertain'`)).rows[0];
  assert.ok(row, 'the uncertain create is kept to be settled');
  for (let n = 0; n < 50 && engine.sessions.get(row.request)?.state !== 'closed'; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(engine.sessions.get(row.request).state, 'closed', 'the engine was told to close it');
  assert.equal(engine.sessions.get(row.request).billable, true);
  await age(store, row.request);
  assert.equal(await platform.browserSessions.reconcile(), 1);
  const settled = (await store.pool.query('SELECT status, error_code, credits_charged FROM fetch_settlements WHERE request = $1', [row.request])).rows[0];
  assert.deepEqual(settled, {status: 'failed', error_code: 'create_uncertain', credits_charged: '0'});
  assert.equal((await call('GET', '/v1/balance')).body.credits, 90);

  // With an idempotency_key it is left open for the resend, which gets it
  // (from the engine, or started there now), and from then on it bills.
  for (const [cut, key] of [['lost', 'lost-after'], ['cut', 'lost-before']]) {
    const keyed = {allow_hosts: ['lost.example.com'], idempotency_key: key};
    mode = cut;
    assert.equal((await call('POST', '/v1/browser-sessions', {body: keyed})).status, 503);
    mode = null;
    const kept = (await store.pool.query(`SELECT s.request FROM fetch_settlements s JOIN browser_session_records r ON r.id = s.request
      WHERE r.idempotency_key = $1 AND s.error_code = 'create_uncertain' AND s.status = 'pending'`, [key])).rows[0];
    assert.ok(kept, `${key}: kept, uncertain`);
    assert.equal(engine.sessions.get(kept.request)?.state, cut === 'lost' ? 'open' : undefined, `${key}: not closed`);
    const resent = await call('POST', '/v1/browser-sessions', {body: keyed});
    assert.deepEqual([resent.status, resent.body.id, resent.body.status], [200, kept.request, 'open'], key);
    assert.equal(engine.sessions.get(kept.request).state, 'open');
    assert.equal((await call('DELETE', `/v1/browser-sessions/${kept.request}`)).body.credits.charged, 10, `${key}: delivered, so billed`);
  }
  assert.equal((await call('GET', '/v1/balance')).body.credits, 70);

  // Two open at once; the third waits.
  const second = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com']}});
  assert.equal(second.status, 201);
  const third = await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com']}});
  assert.deepEqual([third.status, third.body.error.details.limit, third.headers['retry-after']], [429, 'browser_sessions', '30']);
  assert.deepEqual((await call('GET', '/v1/me')).body.concurrency.browser_sessions, {limit: 2, running: 2});
  await call('DELETE', `/v1/browser-sessions/${first.body.id}`);
  assert.equal((await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com']}})).status, 201);
});

test('reconcile settles sessions that ended on their own, closes overdue ones and settles lost ones', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, engine, platform} = await platformFor(store);
  const make = async () => (await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com']}})).body.id;
  const idle = await make();
  const overdue = await make();
  engine.closeSession(idle, {reason: 'idle'});
  await age(store, idle);
  await age(store, overdue, {overdue: true});
  assert.equal(await platform.browserSessions.reconcile(), 2);
  assert.equal(engine.sessions.get(overdue).close_reason, 'client', 'reconcile closed it');
  const gone = await make();
  engine.sessions.delete(gone);
  await age(store, gone);
  const young = await make();
  assert.equal(await platform.browserSessions.reconcile(), 1, 'a session made under 30 s ago is left alone');
  const rows = new Map((await store.pool.query('SELECT request, status, error_code, credits_charged FROM fetch_settlements')).rows
    .map(row => [row.request, [row.status, row.error_code, Number(row.credits_charged)]]));
  assert.deepEqual(rows.get(idle), ['succeeded', null, 10]);
  assert.deepEqual(rows.get(overdue), ['succeeded', null, 10]);
  assert.deepEqual(rows.get(gone), ['failed', 'browser_session_not_started', 0]);
  assert.deepEqual(rows.get(young), ['pending', null, 0]);
  const view = (await call('GET', `/v1/browser-sessions/${gone}`)).body;
  assert.deepEqual([view.status, view.close_reason, view.error, view.credits.charged], ['closed', 'error', 'browser_session_not_started', 0]);
  assert.equal((await call('GET', '/v1/balance')).body.credits, 70);
});

// Sends an HTTP upgrade by hand; resolves with the answer's status, head and
// body (for a refusal), and the socket (for a 101).
function upgrade(port, path, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = Buffer.alloc(0);
    socket.on('error', reject);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = data.subarray(0, end).toString();
      const status = Number(head.split(' ')[1]);
      const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
      if (status !== 101 && data.length < end + 4 + length) return;
      socket.removeAllListeners('data');
      resolve({status, head, body: status === 101 ? null : JSON.parse(data.subarray(end + 4, end + 4 + length).toString()), socket,
        rest: data.subarray(end + 4)});
    });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: app.fetchx.test\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`);
  });
}

test('a session\'s WebSocket goes to the engine with the service token, never the caller\'s key', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  // The engine's upgrade: records what it was sent, answers 101 and echoes.
  const seen = [];
  const fakeUpgrade = net.createServer(socket => {
    let data = Buffer.alloc(0);
    const onData = chunk => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      seen.push(data.subarray(0, end).toString());
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      if (data.length > end + 4) socket.write(data.subarray(end + 4));
      socket.pipe(socket);
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  await new Promise(resolve => fakeUpgrade.listen(0, '127.0.0.1', resolve));
  const targets = [];
  const {app, call} = await platformFor(store, {deps: {sessionConnect: target => {
    targets.push(target);
    return net.connect(fakeUpgrade.address().port, '127.0.0.1');
  }}});
  await app.listen({host: '127.0.0.1', port: 0});
  t.after(async () => {
    await app.close();
    await new Promise(resolve => fakeUpgrade.close(resolve));
    await store.close();
  });
  const port = app.server.address().port;
  const ws = {Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13'};
  const session = (await call('POST', '/v1/browser-sessions', {body: {allow_hosts: ['shop.example.com']}})).body;
  const path = new URL(session.ws_url).pathname;
  // A client that connects has the session, so an uncertain create bills after all.
  await store.pool.query(`UPDATE fetch_settlements SET error_code = 'create_uncertain' WHERE request = $1`, [session.id]);

  const open = await upgrade(port, path, {...ws, Authorization: `Bearer ${TOKEN}`, Cookie: 'sid=1', 'User-Agent': 'Playwright/1.62.1', 'X-Forwarded-For': '1.2.3.4'});
  assert.equal(open.status, 101, open.head);
  const echoed = new Promise(resolve => {
    let text = open.rest.toString();
    if (text.includes('hello')) resolve(text);
    open.socket.on('data', chunk => { text += chunk; if (text.includes('hello')) resolve(text); });
  });
  open.socket.write('hello');
  assert.equal(await echoed, 'hello');
  open.socket.destroy();
  assert.deepEqual(targets, [{host: 'engine.test', port: 8790}]);
  assert.equal((await store.pool.query('SELECT error_code FROM fetch_settlements WHERE request = $1', [session.id])).rows[0].error_code, null);
  const [head] = seen;
  const [first, ...lines] = head.split('\r\n');
  assert.equal(first, `GET /internal/v1/browser-sessions/${session.id}/ws?tenant=${encodeURIComponent(PROJECT)} HTTP/1.1`);
  const sent = Object.fromEntries(lines.map(line => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
  assert.equal(sent.authorization, `Bearer ${SERVICE_TOKEN}`);
  assert.deepEqual(Object.keys(sent).sort(), ['authorization', 'connection', 'host', 'sec-websocket-key', 'sec-websocket-version', 'upgrade', 'user-agent']);
  assert.ok(!head.includes(TOKEN), 'the caller\'s API key never reaches the engine');

  const refused = async (url, headers, status, code) => {
    const answer = await upgrade(port, url, {...ws, ...headers});
    answer.socket.destroy();
    assert.deepEqual([answer.status, answer.body.error.code], [status, code], `${url}: ${answer.head}`);
    assert.match(answer.body.request_id, /^req_[0-9a-f]{24}$/);
    assert.ok(answer.head.toLowerCase().includes(`x-request-id: ${answer.body.request_id}`), 'the refusal carries its request id');
  };
  await refused(path, {}, 401, 'unauthorized');
  await refused(path, {Authorization: 'Bearer wrong'}, 401, 'unauthorized');
  await refused('/v1/browser-sessions/00000000-0000-4000-8000-000000000000/ws', {Authorization: `Bearer ${TOKEN}`}, 404, 'browser_session_not_found');
  await refused('/v1/browser-sessions/nope/ws', {Authorization: `Bearer ${TOKEN}`}, 404, 'route_not_found');
  await call('DELETE', `/v1/browser-sessions/${session.id}`);
  await refused(path, {Authorization: `Bearer ${TOKEN}`}, 410, 'browser_session_closed');
  assert.equal(seen.length, 1, 'no refused upgrade reached the engine');
});
