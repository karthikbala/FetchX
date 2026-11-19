import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {databaseUrl, openStore, gatewayFor, testConfig, PROJECT} from './helpers.mjs';
import {GatewayError} from '../src/policy.mjs';
import {BUDGETS, autoscalerLimits, budget, budgetAudit, listBudgets, loadBudgets, refreshResidentialUsage, resetBudget,
  residentialOverBudget, setBudget} from '../src/budgets.mjs';
import {CaptchaSolver, captchaSettings} from '../src/captcha/solver.mjs';
import {trialCredits} from '../src/billing/trial.mjs';
import {autoscalerReport} from '../src/browser/pool.mjs';
import {registerControl, controlCsrf, CONTROL_COOKIE} from '../src/control.mjs';
import {grantOperator} from '../src/control-admin.mjs';

const skip = !databaseUrl;
const captcha = {enabled: true, apiKey: 'synthetic-key', maxTaskMicroUsd: 3000, maxDailyMicroUsd: 2_000_000, maxTotalMicroUsd: 20_000_000,
  maxTotalTasks: 100};
const write = (fields = {}) => ({actor: 'ops@example.com', reason: 'test', ...fields});

test('budgets resolve override, then config, then the code default, within hard bounds', () => {
  const config = {captcha: {...captcha}, controlPlane: {creditPolicy: {trialCredits: 25}}};
  assert.equal(budget(config, 'captcha.maxDailyMicroUsd'), 2_000_000);
  assert.equal(budget(config, 'captcha.maxTasksPerRequest'), 4, 'code default');
  assert.equal(budget(config, 'billing.trialCredits'), 25, 'config');
  assert.equal(budget(config, 'fetch.maxAttempts'), 5);
  assert.equal(budget(config, 'residential.evomi.maxDailyMb'), null, 'no cap unless set');
  assert.throws(() => budget(config, 'nope'), {code: 'budget_unknown'});
  // A missing or out-of-bounds config value is refused with the budget's own code.
  assert.throws(() => budget({captcha: {...captcha, maxDailyMicroUsd: 5_000_001}}, 'captcha.maxDailyMicroUsd'), {code: 'captcha_budget_unconfigured'});
  assert.throws(() => budget({}, 'captcha.maxTaskMicroUsd'), {code: 'captcha_budget_unconfigured'});
  assert.throws(() => trialCredits({controlPlane: {creditPolicy: {trialCredits: 1001}}}), {code: 'credit_policy_invalid'});
  const listed = listBudgets(config);
  assert.deepEqual(listed.map(b => b.key), BUDGETS.map(b => b.key));
  const daily = listed.find(b => b.key === 'captcha.maxDailyMicroUsd');
  assert.deepEqual({value: daily.value, default: daily.default, source: daily.source, version: daily.version, owner: daily.owner},
    {value: 2_000_000, default: 2_000_000, source: 'config', version: 0, owner: 'engine'});
  assert.equal(listBudgets(config, {owner: 'platform'}).every(b => b.owner === 'platform'), true);
  assert.equal(listed.find(b => b.key === 'captcha.maxTaskMicroUsd').valid, true);
  assert.equal(listBudgets({captcha: {enabled: true}}).find(b => b.key === 'captcha.maxTaskMicroUsd').valid, false);
  assert.deepEqual(autoscalerLimits({}), {});
});

test('budget overrides are validated, versioned, audited, applied at once and reset to config', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const config = {captcha: {...captcha}};
  let saved = await setBudget(store, config, 'captcha.maxDailyMicroUsd', write({value: 500_000, expectedVersion: 0, reason: 'Lower while testing DataDome'}));
  assert.deepEqual({value: saved.value, default: saved.default, source: saved.source, version: saved.version, updated_by: saved.updated_by},
    {value: 500_000, default: 2_000_000, source: 'database', version: 1, updated_by: 'ops@example.com'});
  assert.equal(budget(config, 'captcha.maxDailyMicroUsd'), 500_000, 'applies to the running gateway at once');
  assert.equal(captchaSettings(config).maxDailyMicroUsd, 500_000);
  // Optimistic versions, bounds, reasons and keys.
  await assert.rejects(setBudget(store, config, 'captcha.maxDailyMicroUsd', write({value: 1, expectedVersion: 0})), {code: 'budget_version_conflict'});
  await assert.rejects(setBudget(store, config, 'captcha.maxDailyMicroUsd', write({value: 5_000_001, expectedVersion: 1})),
    error => error.code === 'budget_value_invalid' && error.details.max === 5_000_000);
  await assert.rejects(setBudget(store, config, 'captcha.maxDailyMicroUsd', write({value: null, expectedVersion: 1})), {code: 'budget_value_invalid'});
  await assert.rejects(setBudget(store, config, 'captcha.maxDailyMicroUsd', write({value: 1.5, expectedVersion: 1})), {code: 'budget_value_invalid'});
  await assert.rejects(setBudget(store, config, 'captcha.maxDailyMicroUsd', write({value: 1, expectedVersion: 1, reason: ' '})), {code: 'budget_reason_required'});
  await assert.rejects(setBudget(store, config, 'captcha.maxDailyMicroUsd', write({value: 1, reason: 'x'})), {code: 'budget_version_required'});
  await assert.rejects(setBudget(store, config, 'captcha.nope', write({value: 1, expectedVersion: 0})), {code: 'budget_unknown'});
  await assert.rejects(resetBudget(store, config, 'captcha.maxTotalMicroUsd', write({expectedVersion: 0})), {code: 'budget_not_overridden'});
  // Nullable budgets take null (no cap) as an override.
  saved = await setBudget(store, config, 'residential.evomi.maxDailyMb', write({value: 2048, expectedVersion: 0}));
  assert.equal(saved.value, 2048);
  saved = await setBudget(store, config, 'residential.evomi.maxDailyMb', write({value: null, expectedVersion: 1}));
  assert.deepEqual([saved.value, saved.source, saved.version], [null, 'database', 2]);
  // Another gateway (another config object) sees the overrides after a load.
  const other = {captcha: {...captcha}};
  assert.equal(budget(other, 'captcha.maxDailyMicroUsd'), 2_000_000);
  assert.deepEqual(await loadBudgets(store.pool, other), {loaded: 2, rejected: []});
  assert.equal(budget(other, 'captcha.maxDailyMicroUsd'), 500_000);
  // Reset returns to config and keeps counting versions.
  saved = await resetBudget(store, config, 'captcha.maxDailyMicroUsd', write({expectedVersion: 1, reason: 'Back to config'}));
  assert.deepEqual([saved.value, saved.source, saved.version], [2_000_000, 'config', 2]);
  assert.equal(budget(config, 'captcha.maxDailyMicroUsd'), 2_000_000);
  const audit = await budgetAudit(store.pool, {key: 'captcha.maxDailyMicroUsd'});
  assert.deepEqual(audit.map(a => [a.action, a.before.value, a.before.source, a.after.value, a.after.source, a.reason, a.actor]).reverse(), [
    ['set', 2_000_000, 'config', 500_000, 'database', 'Lower while testing DataDome', 'ops@example.com'],
    ['reset', 500_000, 'database', 2_000_000, 'config', 'Back to config', 'ops@example.com']]);
  // A row that is no longer valid is reported and never applied.
  await store.pool.query(`INSERT INTO budget_overrides (key, overridden, value, version, reason, updated_by) VALUES
    ('captcha.maxTaskMicroUsd', true, 999999999, 1, 'x', 'sql'), ('retired.key', true, 1, 1, 'x', 'sql')`);
  const loaded = await loadBudgets(store.pool, config);
  assert.deepEqual(loaded.rejected.sort(), ['captcha.maxTaskMicroUsd', 'retired.key']);
  assert.equal(budget(config, 'captcha.maxTaskMicroUsd'), 3000);
});

test('captcha budgets from the portal stop or limit solving', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const config = {captcha: {...captcha}, projects: {}};
  let posts = 0;
  const fetchImpl = async url => {
    posts++;
    const value = url.endsWith('createTask') ? {errorId: 0, taskId: posts} : {errorId: 0, status: 'ready', cost: '0.00145', solution: {token: 'x'.repeat(40)}};
    return {ok: true, body: [Buffer.from(JSON.stringify(value))]};
  };
  const solver = new CaptchaSolver(store, config, {fetchImpl, wait: async () => {}, now: () => 0});
  const solve = project => solver.solve('turnstile', {request: randomUUID(), project, websiteURL: 'https://shop.example.com/',
    userAgent: 'Mozilla/5.0', siteKey: '0x4AAAAAAAsyntheticKey'});
  assert.equal((await solve(PROJECT)).token.length, 40);
  // 0 pauses solving without touching config.
  await setBudget(store, config, 'captcha.maxDailyMicroUsd', write({value: 0, expectedVersion: 0}));
  await assert.rejects(solve(PROJECT), {code: 'captcha_budget_exhausted'});
  await resetBudget(store, config, 'captcha.maxDailyMicroUsd', write({expectedVersion: 1}));
  // Per project: this project has spent 1450 of 4000; a 3000 reservation is over.
  await setBudget(store, config, 'captcha.maxProjectDailyMicroUsd', write({value: 4000, expectedVersion: 0}));
  await assert.rejects(solve(PROJECT), {code: 'captcha_budget_exhausted'});
  assert.equal((await solve('cp_other')).token.length, 40, 'other projects are unaffected');
  await setBudget(store, config, 'captcha.maxTasksPerRequest', write({value: 0, expectedVersion: 0}));
  await assert.rejects(solve('cp_third'), {code: 'captcha_budget_exhausted'});
});

test('attempts, credits, concurrency and trial credits follow their budgets', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const config = testConfig({fetchLimits: {maxAttempts: 1}});
  const blocked = {status: 403, body: '<html><body>Access denied</body></html>'};
  const {call, calls, gateway} = await gatewayFor(store, {config, site: () => blocked});
  let result = await call('POST', '/v1/fetch', {body: {url: 'https://wall.example.com/a', render: 'never'}});
  assert.equal(result.body.status, 'failed');
  assert.equal(result.body.attempts.length, 1, 'config budget: one attempt');
  await setBudget(store, gateway.config, 'fetch.maxAttempts', write({value: 2, expectedVersion: 0}));
  result = await call('POST', '/v1/fetch', {body: {url: 'https://wall.example.com/b', render: 'never'}});
  assert.equal(result.body.attempts.length, 2, 'portal override applies to the next request');
  result = await call('POST', '/v1/fetch', {body: {url: 'https://wall.example.com/c', render: 'never', max_attempts: 1}});
  assert.equal(result.body.attempts.length, 1, 'a caller can still ask for fewer');
  assert.ok(calls.length >= 4);

  // Credits one request may reserve: steps above the cap are skipped.
  await setBudget(store, gateway.config, 'fetch.maxCreditsPerRequest', write({value: 3, expectedVersion: 0}));
  result = await call('POST', '/v1/fetch', {body: {url: 'https://open.example.com/', render: 'never'}});
  assert.equal(result.body.credits.max, 3);
  await resetBudget(store, gateway.config, 'fetch.maxCreditsPerRequest', write({expectedVersion: 1}));

  // Requests running at once per project.
  await store.pool.query(`INSERT INTO fetch_requests (id, project, idempotency_key, input_hash, input, host)
    VALUES ($1, $2, 'stuck', 'h', '\\x00', 'x.example.com')`, [randomUUID(), PROJECT]);
  await setBudget(store, gateway.config, 'fetch.maxConcurrentPerProject', write({value: 1, expectedVersion: 0}));
  result = await call('POST', '/v1/fetch', {body: {url: 'https://open.example.com/2'}});
  assert.equal(result.status, 429);
  assert.equal(result.body.error.code, 'too_many_requests');

  // Trial credits for new accounts.
  await setBudget(store, gateway.config, 'billing.trialCredits', write({value: 250, expectedVersion: 0}));
  assert.equal(trialCredits(gateway.config), 250);
});

test('residential traffic caps skip a provider, then say why when every route is capped', {skip}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  // Direct and datacenter are refused; residential answers with a 2 MB page.
  const site = call => (call.provider === 'direct' || call.provider === 'oxylabs'
    ? {status: 403, body: '<html><body>Access denied</body></html>'}
    : {body: '<html><body><main>' + 'residential content '.repeat(50) + '</main></body></html>', wire_bytes: 2_000_000});
  const config = testConfig({residential: {providers: {
    evomi: {enabled: true, username: 'u', password: 'p', countries: ['US'], maxDailyMb: 1},
    dataimpulse: {enabled: true, username: 'u', password: 'p', countries: ['US']}}}});
  const {call, calls, gateway} = await gatewayFor(store, {config, site});
  let result = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/1', render: 'never'}});
  assert.equal(result.body.status, 'succeeded');
  assert.equal(calls.at(-1).provider, 'evomi');
  await refreshResidentialUsage(store.pool, gateway.config, {maxAgeMs: 0});
  assert.equal(residentialOverBudget(gateway.config, 'evomi'), true, '2 MB used of a 1 MB daily cap');
  assert.equal(residentialOverBudget(gateway.config, 'dataimpulse'), false);
  result = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/2', render: 'never'}});
  assert.equal(result.body.status, 'succeeded');
  assert.equal(calls.at(-1).provider, 'dataimpulse', 'the capped provider is skipped');
  // Capping the other provider from the portal: nothing residential is sent.
  await setBudget(store, gateway.config, 'residential.dataimpulse.maxMonthlyMb', write({value: 0, expectedVersion: 0}));
  const before = calls.length;
  result = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/3', render: 'never'}});
  assert.equal(result.body.status, 'failed');
  assert.ok(calls.slice(before).every(c => c.provider === 'direct' || c.provider === 'oxylabs'));
  assert.ok(result.body.attempts.some(a => a.class === 'residential' && a.result === 'not_admitted' && a.code === 'residential_budget_exhausted'));
  // An explicit residential route that is capped tells the caller to retry later.
  result = await call('POST', '/v1/fetch', {body: {url: 'https://shop.example.com/4', route: {class: 'residential', country: 'US'}}});
  assert.equal(result.body.error.code, 'route_unavailable');
  assert.equal(result.body.error.next.action, 'retry_later');
  // Raising the cap applies at once.
  await setBudget(store, gateway.config, 'residential.evomi.maxDailyMb', write({value: 100, expectedVersion: 0}));
  assert.equal(residentialOverBudget(gateway.config, 'evomi'), false);
});

test('the autoscaler gets portal limits and its report is parsed strictly', () => {
  const config = {};
  assert.deepEqual(autoscalerLimits(config), {});
  const report = {v: 1, enabled: true, month_utc: '2026-11', committed_micro_eur: 12, monthly_budget_micro_eur: 40_000_000,
    monthly_budget_ceiling_micro_eur: 40_000_000, max_additional_workers: 2, max_additional_workers_ceiling: 2, workers: 1};
  assert.deepEqual(autoscalerReport(JSON.stringify(report)), report);
  for (const bad of [{...report, v: 2}, {...report, workers: -1}, {...report, extra: 1}, {...report, month_utc: '2026-13'}, null]) {
    assert.equal(autoscalerReport(JSON.stringify(bad)), null);
  }
  assert.equal(autoscalerReport('{'), null);
  assert.equal(autoscalerReport('x'.repeat(2000)), null);
});

const origin = 'https://fetchx.ai', secret = 'synthetic-bridge-secret-32-bytes-minimum', opToken = 'fxs_' + 'b'.repeat(43);

test('admin budgets API: operator-only, validated, versioned, audited in the shared log', {skip}, async t => {
  const store = await openStore();
  await store.pool.query('TRUNCATE control_operators, routing_rule_audit RESTART IDENTITY');
  const op = {id: randomUUID(), email: 'budgets@example.com'};
  await store.pool.query('INSERT INTO control_users(id, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [op.id, op.email]);
  op.id = (await store.pool.query('SELECT id FROM control_users WHERE email = $1', [op.email])).rows[0].id;
  const controlPlane = {enabled: true, origins: [origin], bridgeSecret: secret, admin: {enabled: true}};
  const report = {v: 1, enabled: true, month_utc: '2026-11', committed_micro_eur: 7_200_000, monthly_budget_micro_eur: 40_000_000,
    monthly_budget_ceiling_micro_eur: 60_000_000, max_additional_workers: 2, max_additional_workers_ceiling: 4, workers: 1};
  const gateway = {config: {controlPlane, captcha: {...captcha}}, store, browserPool: {autoscalerStatus: () => ({...report, received_at: 'now'})}};
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

  assert.equal(code(await send('GET', '/admin/budgets')), 'operator_required');
  await grantOperator(store, op.email, 'cli-test');
  let r = await send('GET', '/admin/budgets');
  assert.equal(r.statusCode, 200);
  const daily = r.json().budgets.find(b => b.key === 'captcha.maxDailyMicroUsd');
  assert.deepEqual({value: daily.value, used: daily.used, version: daily.version, unit: daily.unit, max: daily.max},
    {value: 2_000_000, used: 0, version: 0, unit: 'usd_micro', max: 5_000_000});
  assert.equal(r.json().autoscaler.monthly_budget_ceiling_micro_eur, 60_000_000);

  r = await send('PUT', '/admin/budgets/captcha.maxDailyMicroUsd', {value: 1_000_000, version: 0, reason: 'Half while Expedia runs'});
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().budget.value, r.json().budget.version, r.json().budget.source], [1_000_000, 1, 'database']);
  assert.equal(budget(gateway.config, 'captcha.maxDailyMicroUsd'), 1_000_000);
  assert.equal(code(await send('PUT', '/admin/budgets/captcha.maxDailyMicroUsd', {value: 1, version: 0, reason: 'x'})), 'budget_version_conflict');
  r = await send('PUT', '/admin/budgets/captcha.maxDailyMicroUsd', {value: 9_000_000, version: 1, reason: 'x'});
  assert.deepEqual([r.statusCode, code(r)], [400, 'budget_value_invalid']);
  assert.equal(code(await send('PUT', '/admin/budgets/captcha.maxDailyMicroUsd', {version: 1, reason: 'x'})), 'budget_value_invalid');
  assert.equal(code(await send('PUT', '/admin/budgets/captcha.maxDailyMicroUsd', {value: 1, version: 1})), 'budget_reason_required');
  assert.equal((await send('PUT', '/admin/budgets/captcha.maxDailyMicroUsd', {value: 1, version: 1, reason: 'x', extra: 1})).statusCode, 400);
  assert.equal(code(await send('PUT', '/admin/budgets/not.a.budget', {value: 1, version: 0, reason: 'x'})), 'budget_unknown');
  assert.equal(code(await send('PUT', '/admin/budgets/Bad Key', {value: 1, version: 0, reason: 'x'})), 'budget_unknown');

  // The autoscaler budget is sent to the autoscaler as a limit.
  r = await send('PUT', '/admin/budgets/autoscaler.monthlyBudgetMicroEur', {value: 50_000_000, version: 0, reason: 'More workers for the crawl'});
  assert.equal(r.statusCode, 200);
  assert.deepEqual(autoscalerLimits(gateway.config), {monthly_budget_micro_eur: 50_000_000});

  r = await send('POST', '/admin/budgets/captcha.maxDailyMicroUsd/reset', {version: 1, reason: 'Done'});
  assert.deepEqual([r.json().budget.value, r.json().budget.source, r.json().budget.version], [2_000_000, 'config', 2]);
  assert.equal(code(await send('POST', '/admin/budgets/captcha.maxDailyMicroUsd/reset', {version: 2, reason: 'Again'})), 'budget_not_overridden');

  const history = (await send('GET', '/admin/budgets/captcha.maxDailyMicroUsd/audit')).json().entries;
  assert.deepEqual(history.map(e => [e.rule_id, e.action, e.actor, e.note]), [
    ['budget:captcha.maxDailyMicroUsd', 'reset', op.email, 'Done'], ['budget:captcha.maxDailyMicroUsd', 'set', op.email, 'Half while Expedia runs']]);
  const log = (await send('GET', '/admin/audit')).json().entries;
  assert.deepEqual(log.map(e => `${e.rule_id}:${e.action}`), ['budget:captcha.maxDailyMicroUsd:reset',
    'budget:autoscaler.monthlyBudgetMicroEur:set', 'budget:captcha.maxDailyMicroUsd:set']);
  assert.equal((await send('GET', '/admin/budgets?x=1')).statusCode, 400);
});
