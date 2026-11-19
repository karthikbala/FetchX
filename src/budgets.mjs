// Spend budgets and limits are data, not code. Each one has hard bounds here,
// a value from config (gateway.json) or a code default, and an optional
// override an operator saves in the admin portal:
//
//   effective value = override ?? config ?? default
//
// Overrides are validated against the bounds, versioned (a write names the
// version it read), audited with the operator and a reason, and apply to the
// running gateway at once; the periodic refresh picks up writes made by any
// other process. Removing an override returns the budget to config.
//
// `owner` says which side keeps the budget once the engine and the platform
// are separate services: engine budgets cap spend on providers (2Captcha,
// residential proxies, worker VMs), platform budgets cap what accounts get.
import {GatewayError, fail} from './policy.mjs';

const path = (object, dotted) => dotted.split('.').reduce((value, key) => value?.[key], object);

const captcha = (key, fields) => ({key: `captcha.${key}`, owner: 'engine', group: 'captcha', config: `captcha.${key}`,
  invalidCode: 'captcha_budget_unconfigured', ...fields});
const residential = (provider, name, period, window) => ({key: `residential.${provider}.${period}`, owner: 'engine', group: 'residential',
  unit: 'mb', min: 0, max: 10_000_000, nullable: true, nullLabel: 'No cap', default: null, config: `residential.providers.${provider}.${period}`, window,
  label: `${name} traffic per ${window === '24h' ? '24 hours' : 'calendar month (UTC)'}`,
  description: `Residential proxy traffic through ${name}. When it is used up, auto mode skips ${name} and tries the next route. Empty means no cap.`});

export const BUDGETS = Object.freeze([
  captcha('maxDailyMicroUsd', {unit: 'usd_micro', min: 0, max: 5_000_000, window: '24h',
    label: '2Captcha spend per 24 hours', description: 'All captcha solves together, over a rolling 24 hours. 0 pauses solving.'}),
  captcha('maxTotalMicroUsd', {unit: 'usd_micro', min: 0, max: 50_000_000, window: 'total',
    label: '2Captcha spend in total', description: 'All captcha solves ever recorded. 0 pauses solving.'}),
  captcha('maxProjectDailyMicroUsd', {unit: 'usd_micro', min: 0, max: 5_000_000, nullable: true, nullLabel: 'Same as the 24-hour budget',
    default: null, window: '24h',
    label: '2Captcha spend per project per 24 hours', description: 'Keeps one customer from using the whole daily budget. Empty means the same as the 24-hour budget.'}),
  captcha('maxTaskMicroUsd', {unit: 'usd_micro', min: 1, max: 20_000,
    label: 'Most one captcha may cost', description: 'Reserved before each task; a solve billed above it holds solving until an operator checks.'}),
  captcha('maxTotalTasks', {unit: 'count', min: 0, max: 100_000, window: 'total',
    label: 'Captcha tasks in total', description: 'All captcha tasks ever created.'}),
  captcha('maxTasksPerRequest', {unit: 'count', min: 0, max: 10, default: 4,
    label: 'Captchas per request', description: 'Solves one request may use (DataDome, then a widget; hCaptcha takes rounds).'}),
  residential('evomi', 'Evomi', 'maxDailyMb', '24h'),
  residential('evomi', 'Evomi', 'maxMonthlyMb', 'month'),
  residential('dataimpulse', 'DataImpulse', 'maxDailyMb', '24h'),
  residential('dataimpulse', 'DataImpulse', 'maxMonthlyMb', 'month'),
  {key: 'autoscaler.monthlyBudgetMicroEur', owner: 'engine', group: 'autoscaler', unit: 'eur_micro', min: 0, max: 1_000_000_000,
    nullable: true, nullLabel: 'Host config', default: null, config: null, window: 'month',
    label: 'Worker VM spend per calendar month (UTC)', description: 'Sent to the autoscaler, which never goes above the ceiling in its own host config. Empty means the host config value.'},
  {key: 'autoscaler.maxAdditionalWorkers', owner: 'engine', group: 'autoscaler', unit: 'count', min: 0, max: 64,
    nullable: true, nullLabel: 'Host config', default: null, config: null,
    label: 'Extra worker VMs at once', description: 'Also capped by the host config. Empty means the host config value. 0 stops new workers.'},
  {key: 'fetch.maxAttempts', owner: 'engine', group: 'requests', unit: 'count', min: 1, max: 5, default: 5, config: 'fetchLimits.maxAttempts',
    label: 'Attempts per request', description: 'The most attempts auto mode makes for one request. A caller can ask for fewer with max_attempts, never more.'},
  {key: 'admin.maxProbesPerDay', owner: 'engine', group: 'probes', unit: 'count', min: 0, max: 1000, default: 20,
    config: 'controlPlane.admin.maxProbesPerDay', window: '24h',
    label: 'Reachability probes per 24 hours', description: 'Probes started from this portal. Each sends a few capped requests through every provider.'},
  {key: 'fetch.maxCreditsPerRequest', owner: 'platform', group: 'requests', unit: 'credits', min: 1, max: 100_000, default: 100_000,
    config: 'fetchLimits.maxCreditsPerRequest',
    label: 'Credits one request may reserve', description: 'Caps every metered request, including those without max_credits. Steps that cost more are skipped.'},
  {key: 'fetch.maxConcurrentPerProject', owner: 'platform', group: 'requests', unit: 'count', min: 1, max: 1000, default: 10,
    config: 'fetchLimits.maxConcurrentPerProject',
    label: 'Requests running at once per project', description: 'Further requests get 429 too_many_requests until one finishes.'},
  {key: 'billing.trialCredits', owner: 'platform', group: 'accounts', unit: 'credits', min: 0, max: 1000, default: 1000,
    config: 'controlPlane.creditPolicy.trialCredits', invalidCode: 'credit_policy_invalid',
    label: 'Trial credits per new account', description: 'Granted once per verified user. Changing it does not touch grants already made.'},
].map(entry => Object.freeze(entry)));
const BY_KEY = new Map(BUDGETS.map(entry => [entry.key, entry]));
export const BUDGET_KEYS = Object.freeze(BUDGETS.map(entry => entry.key));

export function budgetDefinition(key) {
  const definition = BY_KEY.get(key);
  if (!definition) fail('budget_unknown', 404);
  return definition;
}

export function validBudgetValue(definition, value) {
  if (value === null) return definition.nullable === true;
  return Number.isSafeInteger(value) && value >= definition.min && value <= definition.max;
}

// ---- Database layer ----

export async function initBudgets(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS budget_overrides (
      key text PRIMARY KEY,
      overridden boolean NOT NULL,
      value bigint,
      version int NOT NULL CHECK (version >= 1),
      reason text NOT NULL,
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS budget_audit (
      id bigserial PRIMARY KEY,
      key text NOT NULL,
      action text NOT NULL CHECK (action IN ('set', 'reset')),
      before jsonb NOT NULL,
      after jsonb NOT NULL,
      reason text NOT NULL,
      actor text NOT NULL,
      at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS budget_audit_key ON budget_audit (key, at);
  `);
  // Residential traffic is summed from the attempts table; keep it cheap.
  await pool.query(`CREATE INDEX IF NOT EXISTS fetch_attempts_residential_started ON fetch_attempts (started_at)
    WHERE class = 'residential'`).catch(() => {});
}

// Overrides loaded from the database, per config object (one per gateway).
const layers = new WeakMap();
const rowView = row => ({overridden: row.overridden, value: row.value === null ? null : Number(row.value), version: row.version,
  reason: row.reason, updated_by: row.updated_by, updated_at: row.updated_at});

// Loads the saved overrides into the config's budget layer. A row that is no
// longer valid (unknown key, out of bounds) is skipped and reported, never
// applied; writes validate first, so that only happens after a code change.
export async function loadBudgets(pool, config) {
  const rows = (await pool.query('SELECT * FROM budget_overrides ORDER BY key')).rows;
  const layer = new Map();
  const rejected = [];
  for (const row of rows) {
    const definition = BY_KEY.get(row.key);
    const view = rowView(row);
    if (!definition || (view.overridden && !validBudgetValue(definition, view.value))) {
      rejected.push(row.key);
      if (definition) layer.set(row.key, {...view, overridden: false, rejected: true});
      continue;
    }
    layer.set(row.key, view);
  }
  layers.set(config, layer);
  return {loaded: rows.length - rejected.length, rejected};
}

function configured(definition, config) {
  if (definition.config) {
    const value = path(config, definition.config);
    if (value !== undefined) return {value, source: 'config'};
  }
  return definition.default === undefined ? {value: undefined, source: 'unset'} : {value: definition.default, source: 'default'};
}

function resolve(config, definition) {
  const saved = layers.get(config)?.get(definition.key);
  const base = configured(definition, config);
  const effective = saved?.overridden ? {value: saved.value, source: 'database'} : base;
  return {saved, base, effective};
}

// The effective value of one budget. Throws the budget's own refusal (503) if
// the value from config is missing or out of bounds, so nothing runs unbounded.
export function budget(config, key) {
  const definition = budgetDefinition(key);
  const {effective} = resolve(config, definition);
  if (effective.value === undefined || !validBudgetValue(definition, effective.value)) {
    fail(definition.invalidCode ?? 'budget_unconfigured', 503);
  }
  return effective.value;
}

// Every budget with where its value comes from, for the admin portal.
// `default` is what the budget is without an override (config or code).
export function listBudgets(config, {owner = null} = {}) {
  return BUDGETS.filter(definition => !owner || definition.owner === owner).map(definition => {
    const {saved, base, effective} = resolve(config, definition);
    const valid = effective.value !== undefined && validBudgetValue(definition, effective.value);
    return {key: definition.key, owner: definition.owner, group: definition.group, label: definition.label,
      description: definition.description, unit: definition.unit, window: definition.window ?? null,
      min: definition.min, max: definition.max, nullable: definition.nullable === true, null_label: definition.nullLabel ?? null,
      value: effective.value ?? null, default: base.value ?? null, default_source: base.source, source: effective.source,
      valid, version: saved?.version ?? 0, reason: saved?.reason ?? null, updated_by: saved?.updated_by ?? null,
      updated_at: saved?.updated_at ?? null};
  });
}

const ACTOR = /^[\w@.+:-]{1,128}$/;
function checkWrite({actor, reason, expectedVersion}) {
  if (typeof actor !== 'string' || !ACTOR.test(actor)) fail('budget_actor_invalid', 400);
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 300) fail('budget_reason_required', 400);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('budget_version_required', 400);
}

async function write(store, config, key, {overridden, value, expectedVersion, actor, reason}) {
  const definition = budgetDefinition(key);
  checkWrite({actor, reason, expectedVersion});
  if (overridden && !validBudgetValue(definition, value)) {
    const error = new GatewayError('budget_value_invalid', 400);
    error.details = {key, min: definition.min, max: definition.max, nullable: definition.nullable === true};
    throw error;
  }
  const base = configured(definition, config);
  const saved = await store.tx(async client => {
    const before = (await client.query('SELECT * FROM budget_overrides WHERE key = $1 FOR UPDATE', [key])).rows[0];
    if ((before?.version ?? 0) !== expectedVersion) fail('budget_version_conflict', 409);
    if (!overridden && !before?.overridden) fail('budget_not_overridden', 409);
    const row = (await client.query(`INSERT INTO budget_overrides (key, overridden, value, version, reason, updated_by)
      VALUES ($1, $2, $3, 1, $4, $5)
      ON CONFLICT (key) DO UPDATE SET overridden = EXCLUDED.overridden, value = EXCLUDED.value, version = budget_overrides.version + 1,
        reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING *`, [key, overridden, overridden ? value : null, reason.trim(), actor])).rows[0];
    const was = before?.overridden ? {value: before.value === null ? null : Number(before.value), source: 'database'}
      : {value: base.value ?? null, source: base.source};
    const now = overridden ? {value, source: 'database'} : {value: base.value ?? null, source: base.source};
    await client.query(`INSERT INTO budget_audit (key, action, before, after, reason, actor) VALUES ($1, $2, $3, $4, $5, $6)`,
      [key, overridden ? 'set' : 'reset', {...was, version: before?.version ?? 0}, {...now, version: row.version}, reason.trim(), actor]);
    return row;
  });
  // Applies to this gateway now; other processes pick it up on refresh.
  await loadBudgets(store.pool, config);
  return listBudgets(config).find(entry => entry.key === saved.key);
}

// Saves an override. expectedVersion is the version the operator read (0 when
// the budget has never been overridden); a mismatch is a 409, never a blind write.
export function setBudget(store, config, key, {value, expectedVersion, actor, reason}) {
  return write(store, config, key, {overridden: true, value, expectedVersion, actor, reason});
}

// Removes the override, so config (or the code default) applies again.
export function resetBudget(store, config, key, {expectedVersion, actor, reason}) {
  return write(store, config, key, {overridden: false, value: null, expectedVersion, actor, reason});
}

export async function budgetAudit(pool, {key = null, limit = 100} = {}) {
  if (key !== null) budgetDefinition(key);
  return (await pool.query(`SELECT id, key, action, before, after, reason, actor, at FROM budget_audit
    WHERE ($1::text IS NULL OR key = $1) ORDER BY id DESC LIMIT $2`, [key, Math.min(Math.max(1, limit), 500)])).rows;
}

// ---- What has been used, for the portal and for enforcement ----

const MB = 1_000_000;
const RESIDENTIAL_USAGE_SQL = `SELECT provider,
    COALESCE(sum(wire_bytes) FILTER (WHERE started_at > now() - interval '24 hours'), 0)::bigint AS daily,
    COALESCE(sum(wire_bytes) FILTER (WHERE started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)::bigint AS monthly
  FROM fetch_attempts
  WHERE class = 'residential' AND wire_bytes IS NOT NULL
    AND started_at >= LEAST(now() - interval '24 hours', date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  GROUP BY provider`;

async function residentialUsage(pool) {
  const usage = {};
  for (const row of (await pool.query(RESIDENTIAL_USAGE_SQL)).rows) {
    if (row.provider) usage[row.provider] = {daily: Number(row.daily), monthly: Number(row.monthly)};
  }
  return usage;
}

// Residential traffic per provider, cached per config for a few seconds. Auto
// mode refreshes it before each request; the cap is checked against it at
// every attempt, so a lowered budget applies at once. Requests already in
// flight can go over a cap by at most one response each.
const residentialCache = new WeakMap();
export async function refreshResidentialUsage(pool, config, {maxAgeMs = 5000, now = Date.now()} = {}) {
  const cached = residentialCache.get(config);
  if (cached && now - cached.at < maxAgeMs) return cached.usage;
  if (cached?.pending) return cached.pending;
  const pending = residentialUsage(pool).then(usage => {
    residentialCache.set(config, {at: Date.now(), usage});
    return usage;
  }).catch(() => {
    // Unknown usage never blocks traffic; the next request retries the read.
    residentialCache.set(config, {at: 0, usage: cached?.usage ?? {}});
    return cached?.usage ?? {};
  });
  residentialCache.set(config, {at: cached?.at ?? 0, usage: cached?.usage ?? {}, pending});
  return pending;
}

// True when the provider's traffic has reached a cap. A cap of 0 stops the
// provider outright; no recorded traffic counts as zero.
export function residentialOverBudget(config, provider) {
  if (!BY_KEY.has(`residential.${provider}.maxDailyMb`)) return false;
  const usage = residentialCache.get(config)?.usage?.[provider] ?? {daily: 0, monthly: 0};
  const daily = budget(config, `residential.${provider}.maxDailyMb`);
  const monthly = budget(config, `residential.${provider}.maxMonthlyMb`);
  return (daily !== null && usage.daily >= daily * MB) || (monthly !== null && usage.monthly >= monthly * MB);
}

// How much of each windowed budget is used, keyed by budget key.
export async function budgetUsage(pool) {
  const used = {};
  const captchaRow = (await pool.query(`SELECT count(*)::int AS tasks,
      COALESCE(sum(COALESCE(actual_micro_usd, reserved_micro_usd)), 0)::bigint AS total,
      COALESCE(sum(COALESCE(actual_micro_usd, reserved_micro_usd)) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::bigint AS daily
    FROM captcha_solves`)).rows[0];
  used['captcha.maxDailyMicroUsd'] = Number(captchaRow.daily);
  used['captcha.maxTotalMicroUsd'] = Number(captchaRow.total);
  used['captcha.maxTotalTasks'] = captchaRow.tasks;
  const busiest = (await pool.query(`SELECT COALESCE(max(spent), 0)::bigint AS spent FROM (
      SELECT sum(COALESCE(actual_micro_usd, reserved_micro_usd)) AS spent FROM captcha_solves
      WHERE created_at > now() - interval '24 hours' GROUP BY project) AS projects`)).rows[0];
  used['captcha.maxProjectDailyMicroUsd'] = Number(busiest.spent);
  const traffic = await residentialUsage(pool);
  for (const provider of ['evomi', 'dataimpulse']) {
    used[`residential.${provider}.maxDailyMb`] = Math.ceil((traffic[provider]?.daily ?? 0) / MB);
    used[`residential.${provider}.maxMonthlyMb`] = Math.ceil((traffic[provider]?.monthly ?? 0) / MB);
  }
  used['admin.maxProbesPerDay'] = Number((await pool.query(`SELECT count(*)::int AS n FROM admin_probes
    WHERE created_at > now() - interval '24 hours'`)).rows[0].n);
  return used;
}

// The autoscaler's limits as sent in /v1/pool-metrics. Only set values are
// sent; the autoscaler applies each one up to the ceiling in its host config.
export function autoscalerLimits(config) {
  const limits = {};
  const budgetValue = budget(config, 'autoscaler.monthlyBudgetMicroEur');
  const workers = budget(config, 'autoscaler.maxAdditionalWorkers');
  if (budgetValue !== null) limits.monthly_budget_micro_eur = budgetValue;
  if (workers !== null) limits.max_additional_workers = workers;
  return limits;
}
