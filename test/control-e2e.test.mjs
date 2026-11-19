// Self-service end to end, through the real app: sign in, create projects,
// fetch from the console and with API keys, and check that credits move only
// when a fetch succeeds. Every table lives in a fresh schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import pg from 'pg';
import {Store} from '../src/store.mjs';
import {createGateway, server} from '../src/server.mjs';
import {GatewayError} from '../src/policy.mjs';
import {fakeExchange, html, PUBLIC_ADDRESS} from './helpers.mjs';

const ORIGIN = 'http://127.0.0.1:4331';
const SCOPES = ['fetch:read', 'fetch:write', 'usage:read'];
const TRIAL = 10;

test('self-service: identity, isolation, keys, idempotency and success-only credits', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.match(decodeURIComponent(url.pathname), /^\/gateway_test_[A-Za-z0-9_]+$/, 'explicit disposable gateway_test_* database required');
  const schema = 'control_e2e_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({connectionString: url.href, max: 1});
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  const store = new Store(url.href);
  await store.init();
  const config = {
    release: 'control-e2e', artifactKey: randomBytes(32).toString('hex'), projects: {}, proxies: [],
    controlPlane: {enabled: true, origins: [ORIGIN], bridgeSecret: randomBytes(32).toString('hex'), sessionSecure: false,
      allowLoopbackDevelopment: true, apiBaseUrl: 'http://127.0.0.1:8789', creditPolicy: {trialCredits: TRIAL}},
  };
  // The site: answers 200 unless told otherwise; `hold` parks a request until released.
  let mode = 'ok';
  let hold = null;
  let resolveAddress = PUBLIC_ADDRESS;
  const {exchange, calls} = fakeExchange(async () => {
    if (hold) await hold.promise;
    if (mode === 'forbidden') return {status: 403, body: 'Forbidden'};
    if (mode === 'timeout') return new GatewayError('source_timeout', 504);
    return {body: html('fixture value 42')};
  });
  const mailbox = [];
  const gateway = createGateway({store, config, deps: {exchange, resolve: async () => resolveAddress, runtime: null, browserPool: null,
    mail: {configured: true, sendCode: async message => { mailbox.push(message); }}}});
  const app = server(gateway, {stripeAutoProcess: false});
  t.after(async () => {
    hold?.resolve();
    await app.close();
    await store.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const bridge = {origin: ORIGIN, 'x-fetchx-control-secret': config.controlPlane.bridgeSecret};
  const console_ = async (method, path, payload, actor, overrides = {}) => {
    const headers = {...bridge, ...(actor ? {cookie: actor.cookie, 'x-csrf-token': actor.csrf} : {}), ...overrides};
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    const response = await app.inject({method, url: '/control' + path, headers, ...(payload === undefined ? {} : {payload})});
    assert.equal(response.headers['cache-control'], 'no-store');
    return {status: response.statusCode, body: response.json(), headers: response.headers};
  };
  const api = async (method, path, payload, token) => {
    const response = await app.inject({method, url: path, headers: token ? {authorization: 'Bearer ' + token} : {},
      ...(payload === undefined ? {} : {payload})});
    return {status: response.statusCode, body: response.json()};
  };
  const noDispatch = async fn => {
    const before = calls.length;
    await fn();
    assert.equal(calls.length, before, 'refused and read-only requests never reach the site');
  };
  const signIn = async email => {
    const started = await console_('POST', '/auth/code', {email});
    assert.equal(started.status, 200);
    const message = mailbox.findLast(m => m.challenge_id === started.body.challenge_id);
    assert.ok(!JSON.stringify(started.body).includes(message.code), 'the code only travels by mail');
    const verified = await console_('POST', '/auth/verify', {email, challenge_id: message.challenge_id, code: message.code});
    assert.equal(verified.status, 200);
    const cookie = verified.headers['set-cookie'];
    assert.match(cookie, /^fetchx_session=fxs_[A-Za-z0-9_-]{43};/);
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    return {user: verified.body.user, cookie: cookie.split(';')[0], csrf: verified.body.csrf_token, message};
  };
  const balance = async (project, actor) => (await console_('GET', `/projects/${project}/billing`, undefined, actor)).body.balance;
  let a, b, projectA, projectB, keyA, keyB, first;

  await t.test('sign-in codes are single use, bound to the email, and rate limited', async () => {
    await noDispatch(async () => {
      assert.equal((await console_('GET', '/status', undefined, null, {'x-fetchx-control-secret': undefined})).body.error.code, 'bridge_rejected');
      for (const origin of [undefined, 'http://localhost:4331', ORIGIN + '.attacker.example']) {
        assert.equal((await console_('GET', '/status', undefined, null, {origin})).body.error.code, 'origin_rejected');
      }
      const status = await console_('GET', '/status');
      assert.equal(status.body.api_base_url, 'http://127.0.0.1:8789');
      assert.ok(!JSON.stringify(status.body).includes(config.controlPlane.bridgeSecret));
      a = await signIn('owner-a@example.com');
      b = await signIn('owner-b@example.com');
      assert.notEqual(a.user.id, b.user.id);
      const replay = await console_('POST', '/auth/verify', {email: a.message.email, challenge_id: a.message.challenge_id, code: a.message.code});
      assert.equal(replay.status, 401);
      for (let i = 0; i < 3; i++) await console_('POST', '/auth/code', {email: 'limited@example.com'});
      const sent = mailbox.length;
      assert.equal((await console_('POST', '/auth/code', {email: 'limited@example.com'})).status, 429);
      assert.equal(mailbox.length, sent);
    });
  });

  await t.test('CSRF is enforced and only the first project gets the trial', async () => {
    for (const headers of [{'x-csrf-token': undefined}, {'x-csrf-token': b.csrf}]) {
      assert.equal((await console_('POST', '/projects', {name: 'rejected'}, a, headers)).body.error.code, 'csrf_rejected');
    }
    assert.equal((await console_('POST', '/projects', {name: 'injected', trialCredits: 1_000_000}, a)).status, 400);
    projectA = (await console_('POST', '/projects', {name: 'A'}, a)).body.project;
    projectB = (await console_('POST', '/projects', {name: 'B'}, b)).body.project;
    assert.match(projectA.id, /^cp_[a-f0-9-]{36}$/);
    const second = (await console_('POST', '/projects', {name: 'A second'}, a)).body.project;
    assert.equal((await balance(projectA.id, a)).available, TRIAL);
    assert.equal((await balance(second.id, a)).available, 0);
    await noDispatch(async () => {
      const denied = await console_('POST', `/projects/${second.id}/fetch`, {url: 'https://shop.example.com/'}, a);
      assert.equal(denied.status, 402);
      assert.equal(denied.body.error.code, 'insufficient_credits');
    });
  });

  await t.test('a console fetch succeeds, costs the price of its step, and is listed', async () => {
    first = await console_('POST', `/projects/${projectA.id}/fetch`, {url: 'https://shop.example.com/data', formats: ['markdown'], idempotency_key: 'first'}, a);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, 'succeeded');
    assert.match(first.body.data.markdown, /fixture value 42/);
    assert.equal(first.body.credits.charged, 1);
    await noDispatch(async () => {
      const again = await console_('GET', `/projects/${projectA.id}/fetch/${first.body.id}`, undefined, a);
      assert.equal(again.body.id, first.body.id);
      assert.deepEqual((await console_('GET', `/projects/${projectA.id}/fetch`, undefined, a)).body.items.map(r => r.id), [first.body.id]);
      assert.equal((await balance(projectA.id, a)).available, TRIAL - 1);
      const usage = await console_('GET', `/projects/${projectA.id}/usage`, undefined, a);
      assert.equal(usage.body.used.credits, 1);
      assert.equal(usage.body.used.succeeded, 1);
    });
  });

  await t.test('every project resource checks membership; keys never cross projects', async () => {
    keyA = (await console_('POST', `/projects/${projectA.id}/keys`, {name: 'A key', scopes: SCOPES}, a)).body;
    keyB = (await console_('POST', `/projects/${projectB.id}/keys`, {name: 'B key', scopes: SCOPES}, b)).body;
    assert.match(keyA.token, /^fxk_[A-Za-z0-9_-]{43}$/);
    const paths = [['GET', `/projects/${projectA.id}`], ['GET', `/projects/${projectA.id}/keys`], ['GET', `/projects/${projectA.id}/usage`],
      ['GET', `/projects/${projectA.id}/billing`], ['GET', `/projects/${projectA.id}/fetch`], ['GET', `/projects/${projectA.id}/fetch/${first.body.id}`],
      ['POST', `/projects/${projectA.id}/fetch`, {url: 'https://shop.example.com/'}], ['DELETE', `/projects/${projectA.id}/keys/${keyA.key.id}`]];
    await noDispatch(async () => {
      for (const [method, path, body] of paths) {
        const denied = await console_(method, path, body, b);
        assert.equal(denied.status, 404, method + ' ' + path);
      }
      assert.equal((await api('GET', `/v1/fetch/${first.body.id}`, undefined, keyB.token)).status, 404);
      const keys = await console_('GET', `/projects/${projectA.id}/keys`, undefined, a);
      assert.ok(!JSON.stringify(keys.body).includes(keyA.token));
    });
  });

  await t.test('API keys are scoped, rotate and revoke', async () => {
    const readOnly = (await console_('POST', `/projects/${projectA.id}/keys`, {name: 'usage only', scopes: ['usage:read']}, a)).body;
    await noDispatch(async () => {
      assert.equal((await api('GET', '/v1/usage', undefined, readOnly.token)).status, 200);
      const forbidden = await api('POST', '/v1/fetch', {url: 'https://shop.example.com/'}, readOnly.token);
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.body.error.code, 'api_key_scope_forbidden');
    });
    const viaKey = await api('POST', '/v1/fetch', {url: 'https://shop.example.com/k'}, keyA.token);
    assert.equal(viaKey.body.status, 'succeeded');
    const old = keyA;
    keyA = (await console_('POST', `/projects/${projectA.id}/keys/${old.key.id}/rotate`, {}, a)).body;
    assert.notEqual(keyA.token, old.token);
    await noDispatch(async () => {
      assert.equal((await api('GET', '/v1/usage', undefined, old.token)).status, 401);
      assert.equal((await api('GET', '/v1/usage', undefined, keyA.token)).status, 200);
    });
    assert.equal((await console_('DELETE', `/projects/${projectA.id}/keys/${keyA.key.id}`, undefined, a)).body.revoked, true);
    await noDispatch(async () => assert.equal((await api('POST', '/v1/fetch', {url: 'https://shop.example.com/'}, keyA.token)).status, 401));
  });

  await t.test('one idempotency key runs once; a different body cannot reuse it', async () => {
    hold = Promise.withResolvers();
    const before = calls.length;
    const pending = api('POST', '/v1/fetch', {url: 'https://shop.example.com/c', idempotency_key: 'concurrent'}, keyB.token);
    while (calls.length === before) await new Promise(resolve => setTimeout(resolve, 5));
    try {
      const conflict = await api('POST', '/v1/fetch', {url: 'https://shop.example.com/other', idempotency_key: 'concurrent'}, keyB.token);
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error.code, 'idempotency_conflict');
    } finally {
      hold.resolve();
      hold = null;
    }
    const completed = await pending;
    assert.equal(completed.body.status, 'succeeded');
    await noDispatch(async () => {
      const replay = await api('POST', '/v1/fetch', {url: 'https://shop.example.com/c', idempotency_key: 'concurrent'}, keyB.token);
      assert.equal(replay.body.id, completed.body.id);
    });
    assert.equal(calls.length, before + 1);
    assert.equal((await balance(projectB.id, b)).available, TRIAL - 1, 'charged once');
  });

  await t.test('private destinations and leaked credentials are refused before anything is sent or reserved', async () => {
    const before = await balance(projectA.id, a);
    await noDispatch(async () => {
      for (const target of ['https://127.0.0.1/', 'https://user@shop.example.com/', 'ftp://shop.example.com/', 'https://shop.example.com/?k=' + keyB.token]) {
        const denied = await console_('POST', `/projects/${projectA.id}/fetch`, {url: target}, a);
        assert.equal(denied.status, 400, target);
      }
      resolveAddress = [{address: '10.0.0.8', family: 4}];
      try {
        const ssrf = await console_('POST', `/projects/${projectA.id}/fetch`, {url: 'https://internal.example.com/'}, a);
        assert.equal(ssrf.body.status, 'failed');
        assert.equal(ssrf.body.error.code, 'url_not_allowed');
      } finally {
        resolveAddress = PUBLIC_ADDRESS;
      }
    });
    assert.deepEqual(await balance(projectA.id, a), before);
  });

  await t.test('a failed fetch costs nothing', async () => {
    const before = await balance(projectA.id, a);
    mode = 'forbidden';
    try {
      const blocked = await console_('POST', `/projects/${projectA.id}/fetch`, {url: 'https://walled.example.com/', route: {class: 'direct'}}, a);
      assert.equal(blocked.body.status, 'failed');
      assert.equal(blocked.body.error.code, 'blocked');
      assert.equal(blocked.body.credits.charged, 0);
      mode = 'timeout';
      const timedOut = await console_('POST', `/projects/${projectA.id}/fetch`, {url: 'https://slow.example.com/', route: {class: 'direct'}}, a);
      assert.equal(timedOut.body.status, 'failed');
      assert.equal(timedOut.body.credits.charged, 0);
    } finally {
      mode = 'ok';
    }
    assert.deepEqual(await balance(projectA.id, a), before);
  });

  await t.test('concurrent requests never overdraw the balance', async () => {
    let remaining = (await balance(projectA.id, a)).available;
    for (let i = 0; remaining > 1; i++, remaining--) {
      assert.equal((await console_('POST', `/projects/${projectA.id}/fetch`, {url: `https://shop.example.com/drain/${i}`}, a)).body.status, 'succeeded');
    }
    const pair = await Promise.all(['x', 'y'].map(k => console_('POST', `/projects/${projectA.id}/fetch`, {url: `https://shop.example.com/last/${k}`}, a)));
    assert.equal(pair.filter(r => r.body.status === 'succeeded').length, 1);
    const denied = pair.find(r => r.body.status !== 'succeeded');
    assert.equal(denied.status, 402);
    assert.equal(denied.body.error.code, 'insufficient_credits');
    assert.deepEqual(await balance(projectA.id, a), {credits: 0, reserved: 0, available: 0, trial: TRIAL, purchased: 0, held: false});
  });

  await t.test('logout revokes the session and clears the cookie', async () => {
    const logout = await console_('POST', '/auth/logout', {}, a);
    assert.equal(logout.body.logged_out, true);
    assert.match(logout.headers['set-cookie'], /Max-Age=0/);
    assert.equal((await console_('GET', '/session', undefined, a)).status, 401);
    assert.equal((await console_('GET', '/session', undefined, b)).status, 200);
  });
});
