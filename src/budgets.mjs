// Limits on what accounts get are data, not code. Each one has hard bounds
// here, a value from config (platform.json) or a code default, and an optional
// override an operator saves in the admin portal:
//
//   effective value = override ?? config ?? default
//
// Overrides are validated against the bounds, versioned (a write names the
// version it read), audited with the operator and a reason, and apply to the
// running platform at once; the periodic refresh picks up writes made by any
// other process. Removing an override returns the budget to config.
//
// These are the platform's budgets: credits one request may reserve, requests
// at once per project and trial credits. Provider spend (2Captcha, residential
// traffic, worker VMs, attempts, probes) is capped by the engine's own budgets,
// behind its admin API; the admin portal shows both lists together.
import {GatewayError, fail} from './policy.mjs';

const path = (object, dotted) => dotted.split('.').reduce((value, key) => value?.[key], object);

export const BUDGETS = Object.freeze([
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
}

// Overrides loaded from the database, per config object (one per platform).
const layers = new WeakMap();
const rowView = row => ({overridden: row.overridden, value: row.value === null ? null : Number(row.value), version: row.version,
  reason: row.reason, updated_by: row.updated_by, updated_at: row.updated_at});

// Loads the saved overrides into the config's budget layer. A row that is no
// longer valid (out of bounds) is skipped and reported, never applied; writes
// validate first, so that only happens after a code change. Rows for the
// engine's budgets, left from before the split, are not read.
export async function loadBudgets(pool, config) {
  const rows = (await pool.query('SELECT * FROM budget_overrides WHERE key = ANY($1) ORDER BY key', [BUDGET_KEYS])).rows;
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
  // Applies to this platform now; other processes pick it up on refresh.
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
    WHERE key = ANY($3) AND ($1::text IS NULL OR key = $1) ORDER BY id DESC LIMIT $2`, [key, Math.min(Math.max(1, limit), 500), BUDGET_KEYS])).rows;
}
