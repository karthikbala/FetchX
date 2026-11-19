#!/usr/bin/env node
// One-time move from the single gateway to the platform and the engine
// (docs/split-migration.md). The platform keeps the gateway's database; the
// engine gets a database of its own. Run it with the old gateway and the engine
// stopped, after the engine has been started once so that its tables exist.
//
//   DATABASE_URL=<the gateway's database, now the platform's>
//   ENGINE_DATABASE_URL=<the engine's database>
//   PLATFORM_CONFIG=<platform.json>
//   node scripts/split-migrate.mjs --old-config <gateway.json> [--apply]
//
// Without --apply it only counts. Every step can be run again: rows already
// moved are left alone. What it does:
//   1. creates the platform's new tables (fetch_settlements, webhook_deliveries);
//   2. writes a settlement for every request, from fetch_requests and
//      credit_charges, and releases reservations no running request holds;
//   3. re-seals webhook secrets from the gateway's artifactKey to sealingKey,
//      keeping the gateway's sealed copies in split_gateway_webhook_secrets for
//      a rollback;
//   4. copies the engine's tables: fetch_requests (project becomes tenant, the
//      winning attempt becomes usage), fetch_content, fetch_attempts,
//      routing_rules, routing_rule_audit, site_routes, captcha_solves,
//      admin_probes, and the engine's budget overrides and their audit rows
//      (every key the platform does not own). Stored requests and results stay
//      sealed with the gateway's artifactKey, so the engine must keep that key.
// The gateway's copies of the engine tables are left in place; drop them once
// the engine is verified (see the doc). Requests still pending are copied as
// pending: the engine closes them as uncertain when it starts and reports
// them, and the platform releases their credits.
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {Store} from '../src/store.mjs';
import {Sealer} from '../src/crypto.mjs';
import {BUDGET_KEYS} from '../src/budgets.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const oldConfigPath = args[args.indexOf('--old-config') + 1];
if (!args.includes('--old-config') || !oldConfigPath || oldConfigPath.startsWith('--')) throw new Error('split_old_config_required');
if (!process.env.DATABASE_URL || !process.env.ENGINE_DATABASE_URL) throw new Error('split_database_urls_required');
if (process.env.DATABASE_URL === process.env.ENGINE_DATABASE_URL) throw new Error('split_engine_database_must_differ');

const oldConfig = JSON.parse(await readFile(oldConfigPath, 'utf8'));
const config = JSON.parse(await readFile(process.env.PLATFORM_CONFIG ?? '/run/secrets/platform.json', 'utf8'));
const oldSealer = new Sealer(oldConfig.artifactKey);
const sealer = new Sealer(config.sealingKey);

// The engine's tables, in foreign-key order, with how each row is read from the
// gateway's table and the key used to page through it. `where` keeps only some
// rows; `optional` tables may be missing in a gateway older than them.
if (!BUDGET_KEYS.every(key => /^[A-Za-z.]+$/.test(key))) throw new Error('split_budget_keys_invalid');
const ENGINE_BUDGET = `t.key NOT IN (${BUDGET_KEYS.map(key => `'${key}'`).join(', ')})`;
const STEP = `a.transport || CASE WHEN a.class = 'residential' THEN '_residential' ELSE '' END`;
const ENGINE_TABLES = [
  {table: 'fetch_requests', key: ['id'], batch: 200,
    columns: ['id', 'tenant', 'idempotency_key', 'input_hash', 'input', 'host', 'status', 'error_code', 'usage', 'tags', 'result', 'created_at',
      'deadline', 'finished_at', 'content_deleted_at'],
    select: `t.id, t.project AS tenant, t.idempotency_key, t.input_hash, t.input, t.host, t.status, t.error_code,
      CASE WHEN t.status = 'succeeded' THEN (SELECT jsonb_build_object('step', ${STEP},
          'captcha_solved', COALESCE((SELECT c.captcha FROM credit_charges c WHERE c.request = t.id), COALESCE(a.captcha::text LIKE '%"passed"%', false)),
          'wire_bytes', COALESCE(a.wire_bytes, 0))
        FROM fetch_attempts a WHERE a.request = t.id AND a.result IN ('success', 'answered') ORDER BY a.n DESC LIMIT 1) END AS usage,
      t.tags, t.result, t.created_at, t.created_at + interval '200 seconds' AS deadline, t.finished_at, t.content_deleted_at`},
  {table: 'fetch_content', key: ['request', 'kind'], batch: 20},
  {table: 'fetch_attempts', key: ['request', 'n'], batch: 500},
  {table: 'routing_rules', key: ['id'], batch: 500},
  {table: 'routing_rule_audit', key: ['id'], batch: 500, sequence: 'id'},
  {table: 'site_routes', key: ['host', 'execution', 'proxy_class', 'provider', 'country'], batch: 500},
  {table: 'captcha_solves', key: ['id'], batch: 500},
  {table: 'admin_probes', key: ['id'], batch: 500},
  {table: 'budget_overrides', key: ['key'], batch: 500, where: ENGINE_BUDGET, optional: true},
  {table: 'budget_audit', key: ['id'], batch: 500, sequence: 'id', where: ENGINE_BUDGET, optional: true},
];

const columnsOf = async (client, table) => (await client.query(`SELECT column_name FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table])).rows.map(row => row.column_name);
// Engine columns that must be given a value: NOT NULL without a default.
const requiredOf = async (client, table) => (await client.query(`SELECT column_name FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`, [table])).rows.map(row => row.column_name);
const count = async (client, sql, params = []) => Number((await client.query(sql, params)).rows[0].count);

async function copyTable(source, target, spec) {
  const engineColumns = await columnsOf(target, spec.table);
  if (!engineColumns.length) throw new Error(`split_engine_table_missing:${spec.table}`);
  const sourceColumns = await columnsOf(source, spec.table);
  if (!sourceColumns.length && spec.optional) return {table: spec.table, source: 0, skipped: 'not_in_gateway'};
  const columns = spec.columns ?? sourceColumns.filter(name => engineColumns.includes(name));
  const missing = (await requiredOf(target, spec.table)).filter(name => !columns.includes(name));
  if (missing.length) throw new Error(`split_engine_columns_unfilled:${spec.table}:${missing.join(',')}`);
  if (spec.columns && spec.columns.some(name => !engineColumns.includes(name))) throw new Error(`split_engine_columns_unknown:${spec.table}`);
  const select = spec.select ?? columns.map(name => `t.${name}`).join(', ');
  const keyList = spec.key.map(name => `t.${name}`).join(', ');
  const total = await count(source, `SELECT count(*) FROM ${spec.table} t${spec.where ? ` WHERE ${spec.where}` : ''}`);
  if (!apply) return {table: spec.table, source: total};
  let last = null;
  let copied = 0;
  for (;;) {
    const conditions = [...(last ? [`(${keyList}) > (${spec.key.map((_, i) => `$${i + 1}`).join(', ')})`] : []), ...(spec.where ? [spec.where] : [])];
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = (await source.query(`SELECT row_to_json(x) AS row, ${spec.key.map((name, i) => `x.k${i}`).join(', ')} FROM
      (SELECT ${select}, ${spec.key.map((name, i) => `t.${name} AS k${i}`).join(', ')} FROM ${spec.table} t ${where} ORDER BY ${keyList} LIMIT ${spec.batch}) x`,
    last ?? [])).rows;
    if (!rows.length) break;
    const values = rows.map(({row}) => Object.fromEntries(columns.map(name => [name, row[name]])));
    const inserted = await target.query(`INSERT INTO ${spec.table} (${columns.join(', ')})
      SELECT ${columns.join(', ')} FROM json_populate_recordset(NULL::${spec.table}, $1::json) ON CONFLICT DO NOTHING`, [JSON.stringify(values)]);
    copied += inserted.rowCount;
    last = spec.key.map((_, i) => rows.at(-1)[`k${i}`]);
  }
  if (spec.sequence) {
    await target.query(`SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT max(${spec.sequence}) FROM ${spec.table}), 1))`,
      [spec.table, spec.sequence]);
  }
  return {table: spec.table, source: total, copied, engine: await count(target, `SELECT count(*) FROM ${spec.table}`)};
}

const store = new Store(process.env.DATABASE_URL);
const engine = new pg.Pool({connectionString: process.env.ENGINE_DATABASE_URL, max: 2});
const report = {apply};
try {
  const old = await columnsOf(store.pool, 'fetch_requests');
  if (!old.includes('project')) throw new Error('split_gateway_tables_missing');

  // 1 and 2: the platform's tables and a settlement per request.
  if (apply) await store.init();
  const settle = `INSERT INTO fetch_settlements (request, project, key_id, status, error_code, step, captcha, credits_max, credits_charged,
      created_at, deadline, settled_at)
    SELECT r.id, r.project, r.key_id, r.status, r.error_code, c.step, COALESCE(c.captcha, false), r.credits_max, r.credits_charged, r.created_at,
      CASE WHEN r.status = 'pending' THEN now() ELSE r.created_at END,
      CASE WHEN r.status = 'pending' THEN NULL ELSE COALESCE(r.finished_at, r.created_at) END
    FROM fetch_requests r LEFT JOIN credit_charges c ON c.request = r.id
    ON CONFLICT (request) DO NOTHING`;
  const orphans = `DELETE FROM credit_reservations WHERE request NOT IN (SELECT id FROM fetch_requests WHERE status = 'pending')`;
  if (apply) {
    await store.tx(async client => {
      report.settlements_written = (await client.query(settle)).rowCount;
      report.orphan_reservations_released = (await client.query(orphans)).rowCount;
    });
  } else {
    report.requests = await count(store.pool, 'SELECT count(*) FROM fetch_requests');
    report.pending = await count(store.pool, `SELECT count(*) FROM fetch_requests WHERE status = 'pending'`);
    report.orphan_reservations = await count(store.pool,
      `SELECT count(*) FROM credit_reservations WHERE request NOT IN (SELECT id FROM fetch_requests WHERE status = 'pending')`);
  }

  // 3: webhook secrets.
  if (apply) {
    await store.pool.query(`CREATE TABLE IF NOT EXISTS split_gateway_webhook_secrets (project text PRIMARY KEY, secret bytea NOT NULL,
      saved_at timestamptz NOT NULL DEFAULT now())`);
  }
  const secrets = (await store.pool.query('SELECT project, secret FROM webhook_secrets')).rows;
  let resealed = 0;
  for (const {project, secret} of secrets) {
    try { sealer.open(secret); continue; } catch { /* still sealed with the gateway's key */ }
    const value = oldSealer.open(secret);
    if (apply) {
      await store.tx(async client => {
        await client.query('INSERT INTO split_gateway_webhook_secrets (project, secret) VALUES ($1, $2) ON CONFLICT (project) DO NOTHING', [project, secret]);
        await client.query('UPDATE webhook_secrets SET secret = $2 WHERE project = $1', [project, sealer.seal(value)]);
      });
    }
    resealed++;
  }
  report.webhook_secrets = {total: secrets.length, [apply ? 'resealed' : 'to_reseal']: resealed};

  // 4: the engine's tables.
  report.engine = [];
  for (const spec of ENGINE_TABLES) report.engine.push(await copyTable(store.pool, engine, spec));

  if (apply) {
    report.check = {
      settlements: await count(store.pool, 'SELECT count(*) FROM fetch_settlements'),
      requests: await count(store.pool, 'SELECT count(*) FROM fetch_requests'),
      charged_in_settlements: await count(store.pool, 'SELECT COALESCE(sum(credits_charged), 0) AS count FROM fetch_settlements'),
      charged_in_ledger: await count(store.pool, 'SELECT COALESCE(sum(credits), 0) AS count FROM credit_charges'),
    };
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await engine.end();
  await store.close();
}
