// The platform's budgets (credits one request may reserve, requests at once per
// project, trial credits): value = override ?? config ?? default, within hard
// bounds, versioned and audited. The admin portal sees them in one list with
// the engine's budgets, which stay in the engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {databaseUrl, openStore, platformFor, testConfig, SERVICE_TOKEN} from './helpers.mjs';
import {GatewayError} from '../src/policy.mjs';
import {BUDGETS, budget, budgetAudit, listBudgets, loadBudgets, resetBudget, setBudget} from '../src/budgets.mjs';
import {trialCredits} from '../src/billing/trial.mjs';
import {registerControl, controlCsrf, CONTROL_COOKIE} from '../src/control.mjs';
import {grantOperator} from '../src/control-admin.mjs';
import {EngineClient} from '../src/engine/client.mjs';
import {fakeEngine} from './fake-engine.mjs';

const skip = !databaseUrl;
const write = (fields = {}) => ({actor: 'ops@example.com', reason: 'test', ...fields});
// Audit rows from the platform and the engine are ordered by time.
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('budgets resolve override, then config, then the code default, within hard bounds', () => {
  const config = {controlPlane: {creditPolicy: {trialCredits: 25}}, fetchLimits: {maxConcurrentPerProject: 3}};
  assert.equal(budget(config, 'billing.trialCredits'), 25, 'config');
  assert.equal(budget(config, 'fetch.maxConcurrentPerProject'), 3);
  assert.equal(budget(config, 'fetch.maxCreditsPerRequest'), 100_000, 'code default');
  assert.throws(() => budget(config, 'nope'), {code: 'budget_unknown'});
  // Provider spend is the engine's to cap.
  for (const key of ['captcha.maxDailyMicroUsd', 'fetch.maxAttempts', 'residential.evomi.maxDailyMb']) {
    assert.throws(() => budget(config, key), {code: 'budget_unknown'});
  }
  // A config value outside the bounds is refused with the budget's own code.
  assert.throws(() => trialCredits({controlPlane: {creditPolicy: {trialCredits: 1001}}}), {code: 'credit_policy_invalid'});
  assert.throws(() => budget({fetchLimits: {maxConcurrentPerProject: 0}}, 'fetch.maxConcurrentPerProject'), {code: 'budget_unconfigured'});
  const listed = listBudgets(config);
  assert.deepEqual(listed.map(b => b.key), BUDGETS.map(b => b.key));
  assert.equal(listed.every(b => b.owner === 'platform'), true);
  const trial = listed.find(b => b.key === 'billing.trialCredits');
  assert.deepEqual({value: trial.value, default: trial.default, source: trial.source, version: trial.version},
    {value: 25, default: 25, source: 'config', version: 0});
});

test('budget overrides are validated, versioned, audited, applied at once and reset to config', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const config = {fetchLimits: {maxConcurrentPerProject: 10}};
  let saved = await setBudget(store, config, 'fetch.maxConcurrentPerProject', write({value: 4, expectedVersion: 0, reason: 'One customer is flooding'}));
  assert.deepEqual({value: saved.value, default: saved.default, source: saved.source, version: saved.version, updated_by: saved.updated_by},
    {value: 4, default: 10, source: 'database', version: 1, updated_by: 'ops@example.com'});
  assert.equal(budget(config, 'fetch.maxConcurrentPerProject'), 4, 'applies to the running platform at once');
  await assert.rejects(setBudget(store, config, 'fetch.maxConcurrentPerProject', write({value: 5, expectedVersion: 0})), {code: 'budget_version_conflict'});
  await assert.rejects(setBudget(store, config, 'fetch.maxConcurrentPerProject', write({value: 1001, expectedVersion: 1})),
    error => error.code === 'budget_value_invalid' && error.details.max === 1000);
  await assert.rejects(setBudget(store, config, 'fetch.maxConcurrentPerProject', write({value: null, expectedVersion: 1})), {code: 'budget_value_invalid'});
  await assert.rejects(setBudget(store, config, 'fetch.maxConcurrentPerProject', write({value: 5, expectedVersion: 1, reason: ' '})),
    {code: 'budget_reason_required'});
  await assert.rejects(setBudget(store, config, 'captcha.maxDailyMicroUsd', write({value: 1, expectedVersion: 0})), {code: 'budget_unknown'});
  await assert.rejects(resetBudget(store, config, 'billing.trialCredits', write({expectedVersion: 0})), {code: 'budget_not_overridden'});
  // Rows for engine budgets, left in this database by the single gateway, are not read.
  await store.pool.query(`INSERT INTO budget_overrides (key, overridden, value, version, reason, updated_by) VALUES
    ('captcha.maxDailyMicroUsd', true, 1, 1, 'x', 'gateway')`);
  await store.pool.query(`INSERT INTO budget_audit (key, action, before, after, reason, actor) VALUES
    ('captcha.maxDailyMicroUsd', 'set', '{}', '{}', 'x', 'gateway')`);
  const other = {fetchLimits: {maxConcurrentPerProject: 10}};
  assert.deepEqual(await loadBudgets(store.pool, other), {loaded: 1, rejected: []});
  assert.equal(budget(other, 'fetch.maxConcurrentPerProject'), 4, 'another process sees the override after a load');
  saved = await resetBudget(store, config, 'fetch.maxConcurrentPerProject', write({expectedVersion: 1, reason: 'Back to config'}));
  assert.deepEqual([saved.value, saved.source, saved.version], [10, 'config', 2]);
  const audit = await budgetAudit(store.pool);
  assert.deepEqual(audit.map(a => [a.key, a.action, a.before.value, a.after.value, a.reason]).reverse(), [
    ['fetch.maxConcurrentPerProject', 'set', 10, 4, 'One customer is flooding'],
    ['fetch.maxConcurrentPerProject', 'reset', 4, 10, 'Back to config']]);
  // An override that is out of bounds after a code change is reported and never applied.
  await store.pool.query(`UPDATE budget_overrides SET overridden = true, value = 5000 WHERE key = 'fetch.maxConcurrentPerProject'`);
  assert.deepEqual((await loadBudgets(store.pool, config)).rejected, ['fetch.maxConcurrentPerProject']);
  assert.equal(budget(config, 'fetch.maxConcurrentPerProject'), 10);
});

test('credits per request, requests at once and trial credits follow their budgets', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const allowed = [];
  const {call, engine, platform} = await platformFor(store, {script: (request, options) => {
    allowed.push(options.allowed);
    return request.url.includes('/slow') ? {hold: gate} : {};
  }});
  await store.pool.query('INSERT INTO credit_adjustments (project, kind, credits, note, actor) VALUES ($1, $2, 1000, $3, $4)',
    ['cp_00000000-0000-4000-8000-000000000001', 'operator', 'budget test', 'test']);
  // Credits one request may reserve: steps above the cap are not allowed.
  await setBudget(store, platform.config, 'fetch.maxCreditsPerRequest', write({value: 3, expectedVersion: 0}));
  let result = await call('POST', '/v1/fetch', {body: {url: 'https://open.example.com/'}});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.credits.max, 3);
  assert.deepEqual(allowed.at(-1), ['http']);
  // A request that needs a browser cannot fit under the cap.
  result = await call('POST', '/v1/fetch', {body: {url: 'https://open.example.com/render', render: 'always'}});
  assert.deepEqual([result.status, result.body.error.code, result.body.error.details?.min_credits], [402, 'max_credits_too_low', 10]);
  await resetBudget(store, platform.config, 'fetch.maxCreditsPerRequest', write({expectedVersion: 1}));
  // Requests running at once per project.
  await setBudget(store, platform.config, 'fetch.maxConcurrentPerProject', write({value: 1, expectedVersion: 0}));
  assert.equal((await call('POST', '/v1/fetch', {body: {url: 'https://slow.example.com/1', async: true}})).status, 202);
  result = await call('POST', '/v1/fetch', {body: {url: 'https://slow.example.com/2', async: true}});
  assert.deepEqual([result.status, result.body.error.code], [429, 'too_many_requests']);
  release();
  await Promise.all([...engine.jobs.values()].map(job => job.done));
  // Trial credits for new accounts.
  await setBudget(store, platform.config, 'billing.trialCredits', write({value: 250, expectedVersion: 0}));
  assert.equal(trialCredits(platform.config), 250);
});

const origin = 'https://fetchx.ai', secret = 'synthetic-bridge-secret-32-bytes-minimum', opToken = 'fxs_' + 'b'.repeat(43);

test('admin budgets: one list and one audit log; platform budgets kept here, engine budgets forwarded', {skip}, async t => {
  const store = await openStore();
  await store.pool.query('TRUNCATE control_operators RESTART IDENTITY');
  const op = {id: randomUUID(), email: 'budgets@example.com'};
  await store.pool.query('INSERT INTO control_users(id, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [op.id, op.email]);
  op.id = (await store.pool.query('SELECT id FROM control_users WHERE email = $1', [op.email])).rows[0].id;
  await grantOperator(store, op.email, 'cli-test');
  const engine = fakeEngine({token: SERVICE_TOKEN});
  const controlPlane = {enabled: true, origins: [origin], bridgeSecret: secret, admin: {enabled: true}, creditPolicy: {trialCredits: 1000}};
  const gateway = {config: {controlPlane}, store,
    engine: new EngineClient({url: 'http://engine.test:8790', serviceToken: SERVICE_TOKEN}, {fetchImpl: engine.fetchImpl})};
  const identity = {session: async value => { if (value === opToken) return {user: op}; throw new GatewayError('unauthorized', 401); }};
  const app = Fastify();
  registerControl(app, gateway, {identity, ledger: {prices: {}, metered: () => true, balance: async () => null,
    usage: async () => ({credits: 0, by_step: [], daily: []})}, service: {}});
  await app.ready();
  t.after(async () => { await app.close(); await store.close(); });
  const send = (method, path, payload) => app.inject({method, url: '/control' + path, headers: {origin, 'x-fetchx-control-secret': secret,
    cookie: `${CONTROL_COOKIE}=${opToken}`, 'x-csrf-token': controlCsrf(opToken, secret), ...(payload === undefined ? {} : {'content-type': 'application/json'})},
  ...(payload === undefined ? {} : {payload})});
  const code = r => r.json().error?.code;

  let r = await send('GET', '/admin/budgets');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().budgets.map(b => `${b.owner}:${b.key}`),
    ['engine:captcha.maxDailyMicroUsd', ...BUDGETS.map(b => `platform:${b.key}`)]);
  assert.equal(r.json().autoscaler, null);

  // A platform budget is changed here; the engine never hears of it.
  const before = engine.admin.length;
  r = await send('PUT', '/admin/budgets/billing.trialCredits', {value: 500, version: 0, reason: 'Smaller trial for the launch'});
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().budget.value, r.json().budget.version, r.json().budget.source, r.json().budget.updated_by],
    [500, 1, 'database', op.email]);
  assert.equal(trialCredits(gateway.config), 500);
  assert.equal(code(await send('PUT', '/admin/budgets/billing.trialCredits', {value: 1, version: 0, reason: 'x'})), 'budget_version_conflict');
  assert.equal(code(await send('PUT', '/admin/budgets/billing.trialCredits', {value: 1001, version: 1, reason: 'x'})), 'budget_value_invalid');
  assert.equal((await send('PUT', '/admin/budgets/billing.trialCredits', {value: 1, version: 1, reason: 'x', extra: 1})).statusCode, 400);
  assert.equal(code(await send('PUT', '/admin/budgets/Bad%20Key', {value: 1, version: 0, reason: 'x'})), 'budget_unknown');
  assert.equal(engine.admin.length, before);

  // An engine budget goes to the engine, with the operator as actor.
  await tick();
  r = await send('PUT', '/admin/budgets/captcha.maxDailyMicroUsd', {value: 1_000_000, version: 0, reason: 'Half while Expedia runs'});
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(engine.admin.at(-1), {method: 'PUT', path: '/budgets/captcha.maxDailyMicroUsd',
    body: {value: 1_000_000, version: 0, reason: 'Half while Expedia runs'}, actor: op.email});
  assert.equal(code(await send('PUT', '/admin/budgets/captcha.maxDailyMicroUsd', {value: 1, version: 0, reason: 'x'})), 'budget_version_conflict');
  assert.equal(code(await send('PUT', '/admin/budgets/not.a.budget', {value: 1, version: 0, reason: 'x'})), 'budget_unknown');

  // Resets and histories go to the side that owns the budget.
  await tick();
  r = await send('POST', '/admin/budgets/billing.trialCredits/reset', {version: 1, reason: 'Launch over'});
  await tick();
  assert.deepEqual([r.json().budget.value, r.json().budget.source, r.json().budget.version], [1000, 'config', 2]);
  r = await send('POST', '/admin/budgets/captcha.maxDailyMicroUsd/reset', {version: 1, reason: 'Done'});
  assert.deepEqual([r.json().budget.value, r.json().budget.source], [2_000_000, 'config']);
  assert.deepEqual((await send('GET', '/admin/budgets/billing.trialCredits/audit')).json().entries.map(e => [e.rule_id, e.action, e.actor, e.note]), [
    ['budget:billing.trialCredits', 'reset', op.email, 'Launch over'], ['budget:billing.trialCredits', 'set', op.email, 'Smaller trial for the launch']]);
  assert.deepEqual((await send('GET', '/admin/budgets/captcha.maxDailyMicroUsd/audit')).json().entries.map(e => e.action), ['reset', 'set']);

  // One audit log, newest first, across both sides.
  const log = (await send('GET', '/admin/audit')).json().entries;
  assert.deepEqual(log.map(e => `${e.rule_id}:${e.action}`), ['budget:captcha.maxDailyMicroUsd:reset', 'budget:billing.trialCredits:reset',
    'budget:captcha.maxDailyMicroUsd:set', 'budget:billing.trialCredits:set']);
  assert.equal((await send('GET', '/admin/budgets?x=1')).statusCode, 400);
});
