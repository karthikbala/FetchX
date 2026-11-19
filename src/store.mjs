// PostgreSQL access: one pool, transactions, the single-runner lock and the
// schema. Each module owns its tables (init*); this file runs them in order.
import pg from 'pg';
import {initControlIdentity} from './control-identity.mjs';
import {initControlAdmin} from './control-admin.mjs';
import {initControlStripe} from './control-stripe.mjs';
import {initPurchases} from './billing/purchases.mjs';
import {initLedger} from './billing/ledger.mjs';
import {initFetchFront} from './fetch/front.mjs';

export class Store {
  constructor(url) {
    this.url = url;
    this.pool = new pg.Pool({connectionString: url, max: 12});
  }

  // Only one platform process runs at a time: it owns settlement and webhook
  // delivery. Losing the lock stops the process.
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
    await initControlStripe(this.pool);
    await initFetchFront(this.pool);
  }

  async close() {
    this.closing = true;
    await this.pool.end();
    if (this.runner) await this.runner.end();
  }
}
