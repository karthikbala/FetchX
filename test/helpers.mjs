// Shared fixtures: a disposable database, a platform wired to an in-memory
// engine (test/fake-engine.mjs), and an HTTP client for the public app. No
// network, no paid calls.
import assert from 'node:assert/strict';
import {sha} from '../src/crypto.mjs';
import {Store} from '../src/store.mjs';
import {createPlatform, server, eventsServer} from '../src/server.mjs';
import {fakeEngine} from './fake-engine.mjs';

export const databaseUrl = process.env.TEST_DATABASE_URL;
export const TOKEN = 'test-token-metered';
export const UNMETERED_TOKEN = 'test-token-unmetered';
export const PROJECT = 'cp_00000000-0000-4000-8000-000000000001';
export const SERVICE_TOKEN = 'synthetic-engine-service-token-0123456789';
export const EVENT_KEY = 'synthetic-engine-event-key-0123456789abcdef';
export const PUBLIC_ADDRESS = [{address: '93.184.216.34', family: 4}];

export function testConfig(overrides = {}) {
  return {
    release: 'test',
    sealingKey: '42'.repeat(32),
    engine: {url: 'http://engine.test:8790', serviceToken: SERVICE_TOKEN, eventKey: EVENT_KEY},
    projects: {[PROJECT]: {tokenHash: sha(TOKEN)}, static: {tokenHash: sha(UNMETERED_TOKEN)}},
    ...overrides,
  };
}

export async function openStore() {
  assert.match(new URL(databaseUrl).pathname, /^\/gateway_test_[A-Za-z0-9_]+$/, 'tests use a disposable gateway_test_* database');
  const store = new Store(databaseUrl);
  await store.init();
  await store.pool.query(`TRUNCATE fetch_settlements, webhook_deliveries, webhook_secrets, credit_reservations, credit_charges, credit_adjustments,
    paid_credit_payment_holds, budget_overrides, budget_audit CASCADE`);
  await store.pool.query('DELETE FROM paid_credit_grants');
  await store.pool.query('DELETE FROM control_credit_accounts WHERE project = $1', [PROJECT]);
  await store.pool.query('INSERT INTO control_credit_accounts (project, granted_credits) VALUES ($1, $2)', [PROJECT, 100]);
  return store;
}

// The platform with a fake engine. `script` decides each job's outcome (see
// fake-engine.mjs); `webhooks` records customer webhook posts; `wrapEngineFetch`
// can watch the client's calls to the engine.
export async function platformFor(store, {config = testConfig(), script, webhookAnswer = () => 200, wrapEngineFetch = fetch => fetch, deps = {}} = {}) {
  const engine = fakeEngine({script, token: config.engine?.serviceToken, eventKey: config.engine?.eventKey});
  const webhooks = [];
  const platform = createPlatform({store, config, deps: {engineFetch: wrapEngineFetch(engine.fetchImpl), webhookIntervalMs: 60_000,
    webhookResolve: async () => PUBLIC_ADDRESS,
    webhookPost: async (url, address, {headers, body}) => {
      webhooks.push({url: url.href, address, headers, body: body.toString(), payload: JSON.parse(body)});
      return webhookAnswer(webhooks.at(-1));
    }, ...deps}});
  const app = server(platform, {stripeAutoProcess: false});
  const events = eventsServer(platform);
  const call = async (method, url, {token = TOKEN, body} = {}) => {
    const response = await app.inject({method, url, headers: {authorization: `Bearer ${token}`}, ...(body ? {payload: body} : {})});
    let json = null;
    try { json = response.json(); } catch { /* binary */ }
    return {status: response.statusCode, body: json, raw: response.rawPayload, headers: response.headers};
  };
  return {platform, gateway: platform, app, events, engine, webhooks, call};
}

export const html = text => `<html><head><title>T</title></head><body><main><h1>Data</h1><p>${text}</p>${'<p>filler text</p>'.repeat(20)}</main></body></html>`;
