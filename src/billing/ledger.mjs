// One credit ledger. A project's balance is
//   trial credits granted (control_credit_accounts)
//   + live purchases (paid_credit_grants, written by Stripe and UPI checkout)
//   + adjustments (opening balances, operator corrections)
//   - charges (successful requests)
//   - open reservations (requests still running).
// A job reserves up to its ceiling before the engine starts it, and is charged
// only if it succeeds, at the price of the step that got the data (at most the
// reservation). Everything else is released. An active payment hold (dispute,
// refund in progress) stops new spending. src/fetch/front.mjs drives this.
import {fail} from '../policy.mjs';

export const STEPS = Object.freeze(['http', 'http_residential', 'browser', 'browser_residential']);
export const DEFAULT_PRICES = Object.freeze({
  http: 1,
  http_residential: 5,
  browser: 10,
  browser_residential: 25,
  captcha: 10,
  // Residential bandwidth is paid per GB, so large pages pay for it.
  residential_included_mb: {http_residential: 1, browser_residential: 5},
  residential_overage_per_mb: 5,
});
const MB = 1_000_000;

export function prices(config) {
  const custom = config?.pricing ?? {};
  const merged = {...DEFAULT_PRICES, ...custom,
    residential_included_mb: {...DEFAULT_PRICES.residential_included_mb, ...custom.residential_included_mb}};
  for (const key of [...STEPS, 'captcha', 'residential_overage_per_mb']) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < 0 || merged[key] > 100_000) fail('pricing_configuration_invalid', 500);
  }
  return merged;
}

// The price of one successful step. Bytes are the wire bytes of that step.
export function priceOf(table, {step, captchaSolved = false, wireBytes = 0}) {
  let credits = table[step] + (captchaSolved ? table.captcha : 0);
  const included = table.residential_included_mb[step];
  if (included !== undefined && Number.isSafeInteger(wireBytes) && wireBytes > included * MB) {
    credits += Math.ceil((wireBytes - included * MB) / MB) * table.residential_overage_per_mb;
  }
  return credits;
}

// The most a step can cost given the response size cap.
export function worstCaseOf(table, step, {captcha = false, maxWireBytes}) {
  return priceOf(table, {step, captchaSolved: captcha && step.startsWith('browser'), wireBytes: maxWireBytes});
}

export async function initLedger(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_adjustments (
      id bigserial PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('opening', 'operator')),
      credits bigint NOT NULL,
      note text NOT NULL,
      actor text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS credit_adjustments_opening ON credit_adjustments (project) WHERE kind = 'opening';
    CREATE TABLE IF NOT EXISTS credit_reservations (
      request uuid PRIMARY KEY,
      project text NOT NULL,
      credits bigint NOT NULL CHECK (credits > 0),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS credit_reservations_project ON credit_reservations (project);
    CREATE TABLE IF NOT EXISTS credit_charges (
      request uuid PRIMARY KEY,
      project text NOT NULL,
      step text NOT NULL,
      credits bigint NOT NULL CHECK (credits > 0),
      captcha boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS credit_charges_project_created ON credit_charges (project, created_at);
  `);
}

const balanceSql = `
  SELECT a.granted_credits::bigint AS trial,
    COALESCE((SELECT sum(credits) FROM paid_credit_grants g
      WHERE g.project = a.project AND g.revoked_at IS NULL AND g.credits IS NOT NULL), 0)::bigint AS purchased,
    COALESCE((SELECT sum(credits) FROM credit_adjustments j WHERE j.project = a.project), 0)::bigint AS adjusted,
    COALESCE((SELECT sum(credits) FROM credit_charges c WHERE c.project = a.project), 0)::bigint AS charged,
    COALESCE((SELECT sum(credits) FROM credit_reservations r WHERE r.project = a.project), 0)::bigint AS reserved,
    EXISTS (SELECT 1 FROM paid_credit_payment_holds h WHERE h.project = a.project AND h.cleared_at IS NULL) AS held
  FROM control_credit_accounts a WHERE a.project = $1`;

export class Ledger {
  constructor({store, config}) {
    this.store = store;
    this.config = config;
  }

  get prices() { return prices(this.config); }

  // Projects provisioned in config (not through the console) are unmetered.
  metered(project) { return typeof project === 'string' && project.startsWith('cp_'); }

  async balance(project, client = this.store.pool) {
    if (!this.metered(project)) return null;
    const row = (await client.query(balanceSql, [project])).rows[0];
    if (!row) fail('credit_account_unavailable', 503);
    const total = Number(row.trial) + Number(row.purchased) + Number(row.adjusted) - Number(row.charged);
    return {
      credits: total,
      reserved: Number(row.reserved),
      available: Math.max(0, total - Number(row.reserved)),
      trial: Number(row.trial),
      purchased: Number(row.purchased),
      held: row.held,
    };
  }

  // Serialises admissions for one project until the caller's transaction ends.
  async lock(client, project) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['credits:' + project]);
  }

  // Holds `credits` for a job until it is charged or released. Call under lock()
  // after checking balance(); runs in the caller's transaction.
  async hold(client, {project, request, credits}) {
    if (!Number.isSafeInteger(credits) || credits < 1) fail('invalid_request', 400);
    await client.query('INSERT INTO credit_reservations (request, project, credits) VALUES ($1, $2, $3)', [request, project, credits]);
  }

  // Charges a successful job (never more than it reserved) and closes its
  // reservation. Idempotent per job.
  async charge(client, {project, request, step, credits, captcha = false}) {
    if (!this.metered(project)) return 0;
    const reservation = (await client.query('DELETE FROM credit_reservations WHERE request = $1 RETURNING credits', [request])).rows[0];
    const amount = Math.min(credits, Number(reservation?.credits ?? credits));
    if (amount > 0) {
      await client.query(`INSERT INTO credit_charges (request, project, step, credits, captcha) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (request) DO NOTHING`, [request, project, step, amount, captcha]);
    }
    return amount;
  }

  async release(client, {request}) {
    await client.query('DELETE FROM credit_reservations WHERE request = $1', [request]);
  }

  async usage(project, {from, to}) {
    const pool = this.store.pool;
    const byStep = (await pool.query(`SELECT step, count(*)::int AS requests, sum(credits)::bigint AS credits
      FROM credit_charges WHERE project = $1 AND created_at >= $2 AND created_at < $3 GROUP BY step ORDER BY step`,
    [project, from, to])).rows.map(row => ({step: row.step, requests: row.requests, credits: Number(row.credits)}));
    const captcha = (await pool.query(`SELECT count(*)::int AS requests FROM credit_charges
      WHERE project = $1 AND captcha AND created_at >= $2 AND created_at < $3`, [project, from, to])).rows[0].requests;
    const daily = (await pool.query(`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
        count(*)::int AS requests, sum(credits)::bigint AS credits
      FROM credit_charges WHERE project = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 1`,
    [project, from, to])).rows.map(row => ({date: row.date, requests: row.requests, credits: Number(row.credits)}));
    return {by_step: byStep, captcha_solved: captcha, daily, credits: byStep.reduce((sum, row) => sum + row.credits, 0)};
  }

  // Operator correction, written to the audit trail by the caller.
  async adjust(client, {project, credits, note, actor}) {
    if (!Number.isSafeInteger(credits) || credits === 0 || !note) fail('invalid_request', 400);
    await client.query(`INSERT INTO credit_adjustments (project, kind, credits, note, actor) VALUES ($1, 'operator', $2, $3, $4)`,
      [project, credits, note.slice(0, 300), actor]);
  }
}
