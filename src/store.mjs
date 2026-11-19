// PostgreSQL access: one pool, transactions, the single-runner lock and the
// schema. Each module owns its tables (init*); this file runs them in order and
// performs the one-time move from the old multi-version schema.
import pg from 'pg';
import {initControlIdentity} from './control-identity.mjs';
import {initControlAdmin} from './control-admin.mjs';
import {initAdminOps} from './admin-ops.mjs';
import {initControlStripe} from './control-stripe.mjs';
import {initPurchases, migrateLegacyGrants} from './billing/purchases.mjs';
import {initLedger, migrateLegacyBalances} from './billing/ledger.mjs';
import {initProviderRules} from './provider-rules.mjs';
import {initSiteKnowledge} from './site-knowledge.mjs';
import {initCaptchaSolves} from './captcha/solver.mjs';
import {initFetchStore} from './fetch/service.mjs';

// Tables of the old v1 and v2 APIs, their per-route ledgers, access profiles
// and the playground. Dropped once their spent credits are carried into the
// one ledger as opening balances.
export const LEGACY_TABLES = Object.freeze([
  'paid_credit_allocations', 'paid_credit_reconciliations', 'paid_credit_reservations', 'control_credit_upgrades',
  'control_credit_reservations', 'v2_captcha_tasks', 'v2_browser_queue_timeouts', 'v2_browser_queue_cursor', 'v2_browser_queue',
  'v2_artifacts', 'v2_ledger_events', 'v2_ledger', 'v2_operations', 'v2_sessions', 'v2_registry', 'v2_discovery_profiles',
  'control_playground_profiles', 'control_playground_policies', 'captcha_tasks', 'residential_reconciliations', 'residential_usage',
  'browser_state', 'operation_outcomes', 'fetch_jobs', 'project_admission', 'admission_queue', 'ledger', 'attempts', 'operations',
  'workflows', 'pool_cursor', 'route_health_workflows', 'route_health_pools', 'route_health', 'source_profile_override_audit',
  'source_profile_overrides', 'source_limits',
]);

export class Store {
  constructor(url) {
    this.url = url;
    this.pool = new pg.Pool({connectionString: url, max: 12});
  }

  // Only one gateway process runs at a time: it owns pending requests and
  // browser slots. Losing the lock stops the process.
  async acquireRunnerLock(onLost) {
    if (this.runner) throw new Error('gateway_runner_lock_already_acquired');
    const client = new pg.Client({connectionString: this.url});
    let active = false;
    let lost = false;
    const loss = () => {
      if (!active || lost || this.closing) return;
      lost = true;
      this.runnerLost = true;
      onLost?.(new Error('gateway_runner_lock_lost'));
    };
    client.on('error', loss);
    client.on('end', loss);
    try {
      await client.connect();
      const row = (await client.query('SELECT pg_try_advisory_lock(170017, 1) AS acquired')).rows[0];
      if (!row.acquired) throw new Error('gateway_runner_already_active');
      this.runner = client;
      active = true;
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }

  async tx(fn) {
    if (this.runnerLost) throw new Error('gateway_runner_lock_lost');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async init() {
    await initControlIdentity(this.pool);
    await initPurchases(this.pool);
    await initLedger(this.pool);
    await initControlAdmin(this.pool);
    await initAdminOps(this.pool);
    await initControlStripe(this.pool);
    await initProviderRules(this.pool);
    await initSiteKnowledge(this.pool);
    await initCaptchaSolves(this.pool);
    await initFetchStore(this.pool);
    await this.migrateLegacy();
  }

  // Carries spent credits into the ledger, then drops the old tables, in one
  // transaction so a failure leaves the old schema untouched.
  async migrateLegacy() {
    const present = (await this.pool.query('SELECT relname FROM pg_class WHERE relkind = \'r\' AND relname = ANY($1)',
      [LEGACY_TABLES])).rows.map(row => row.relname);
    if (!present.length) return {migrated: 0, dropped: 0};
    return this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(170017, 9)');
      const migrated = await migrateLegacyBalances(client);
      for (const table of LEGACY_TABLES) await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      await client.query('DROP FUNCTION IF EXISTS reject_upgraded_trial_reservation() CASCADE');
      await client.query('DROP SEQUENCE IF EXISTS admission_turn');
      await migrateLegacyGrants(client);
      await client.query("DELETE FROM routing_rules WHERE provider = 'scrapedo'");
      // Projects no longer carry an access-profile template.
      await client.query('ALTER TABLE control_projects DROP COLUMN IF EXISTS template_hash');
      return {migrated, dropped: present.length};
    });
  }

  async close() {
    this.closing = true;
    await this.pool.end();
    if (this.runner) await this.runner.end();
  }
}
