// Shared fixtures: a disposable database, a gateway with fake transports, and
// an HTTP client for the app. No network, no paid calls.
import assert from 'node:assert/strict';
import {sha} from '../src/crypto.mjs';
import {Store} from '../src/store.mjs';
import {createGateway, server} from '../src/server.mjs';

export const databaseUrl = process.env.TEST_DATABASE_URL;
export const TOKEN = 'test-token-metered';
export const UNMETERED_TOKEN = 'test-token-unmetered';
export const PROJECT = 'cp_00000000-0000-4000-8000-000000000001';
export const PUBLIC_ADDRESS = [{address: '93.184.216.34', family: 4}];
export const RUNTIME = {engine: 'camoufox', version: '158.0.1-beta.41', sha256: 'a'.repeat(64)};

export function testConfig(overrides = {}) {
  const provider = {enabled: true, username: 'synthetic-user', password: 'synthetic-password', countries: ['US', 'IN']};
  return {
    release: 'test',
    artifactKey: '42'.repeat(32),
    projects: {[PROJECT]: {tokenHash: sha(TOKEN)}, static: {tokenHash: sha(UNMETERED_TOKEN)}},
    proxies: [{id: 'dc-us-1', country: 'US', url: 'http://dc-us.example:8080', provider: 'oxylabs'},
      {id: 'dc-in-1', country: 'IN', url: 'http://dc-in.example:8080', provider: 'oxylabs'}],
    residential: {providers: {evomi: {...provider}, dataimpulse: {...provider}}},
    ...overrides,
  };
}

export async function openStore() {
  assert.match(new URL(databaseUrl).pathname, /^\/gateway_test_[A-Za-z0-9_]+$/, 'tests use a disposable gateway_test_* database');
  const store = new Store(databaseUrl);
  await store.init();
  await store.pool.query(`TRUNCATE fetch_requests, credit_reservations, credit_charges, credit_adjustments, captcha_solves, site_routes,
    paid_credit_payment_holds, budget_overrides, budget_audit CASCADE`);
  await store.pool.query('DELETE FROM paid_credit_grants');
  await store.pool.query('DELETE FROM control_credit_accounts WHERE project = $1', [PROJECT]);
  await store.pool.query('INSERT INTO control_credit_accounts (project, granted_credits) VALUES ($1, $2)', [PROJECT, 100]);
  return store;
}

// site(request) -> {status, headers, body} for each simulated exchange.
// `calls` records what was sent, including which proxy provider carried it.
export function fakeExchange(site) {
  const calls = [];
  const exchange = async (request, destination, limits, {proxy} = {}) => {
    const provider = !proxy ? 'direct' : proxy.url.includes('dc-') ? 'oxylabs' : proxy.id?.split(':')[0];
    const call = {url: destination.url.href, method: request.method, headers: request.headers, provider, address: destination.address};
    calls.push(call);
    const answer = await site(call);
    if (answer instanceof Error) throw answer;
    const body = Buffer.from(answer.body ?? '');
    return {status: answer.status ?? 200, headers: {'content-type': 'text/html; charset=utf-8', ...answer.headers}, encoded: body,
      wire_bytes: answer.wire_bytes ?? body.length + 500, provider_status: proxy ? 200 : null};
  };
  return {exchange, calls};
}

// A browser slot that plays a scripted page instead of launching Camoufox.
export function fakeBrowser(script) {
  const runs = [];
  return {
    runs,
    slots: {
      acquire: async () => ({
        release() {},
        run: async (input, hooks) => {
          runs.push(input);
          await hooks.admit({url: input.url, method: 'GET', resource_type: 'document', frame: 'main', navigation: true, body_bytes: 0});
          return script(input, hooks);
        },
      }),
    },
  };
}

export async function gatewayFor(store, {config = testConfig(), site = () => ({body: '<html><body>ok</body></html>'}), browser, solver} = {}) {
  const {exchange, calls} = fakeExchange(site);
  const gateway = createGateway({store, config, deps: {
    exchange, resolve: async () => PUBLIC_ADDRESS, runtime: browser ? RUNTIME : null,
    browserPool: null, slots: browser?.slots, ...(solver ? {solver} : {}),
  }});
  const app = server(gateway);
  const call = async (method, url, {token = TOKEN, body} = {}) => {
    const response = await app.inject({method, url, headers: {authorization: `Bearer ${token}`}, ...(body ? {payload: body} : {})});
    let json = null;
    try { json = response.json(); } catch { /* binary */ }
    return {status: response.statusCode, body: json, raw: response.rawPayload, headers: response.headers};
  };
  return {gateway, app, calls, call};
}

export const html = text => `<html><head><title>T</title></head><body><main><h1>Data</h1><p>${text}</p>${'<p>filler text</p>'.repeat(20)}</main></body></html>`;
