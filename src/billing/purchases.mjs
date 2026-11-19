// Credit purchases (Stripe card in USD, UPI in INR). Stripe events call these
// inside their own transaction; every grant is keyed by the payment's immutable
// identifiers, so a replayed event never grants twice. A refund or a lost
// dispute revokes the grant; an open dispute or refund puts the project on a
// payment hold, which stops spending until it clears.
import {fail} from '../policy.mjs';
import {PACK_OFFERS} from '../control-stripe-broker-protocol.mjs';

const ACCOUNT = /^acct_[A-Za-z0-9_]{1,200}$/;
const SESSION = /^cs_live_[A-Za-z0-9_]{1,200}$/;
const INTENT = /^pi_[A-Za-z0-9_]{1,200}$/;
const HOLD = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,239}$/;
const PACKAGES = new Map(Object.values(PACK_OFFERS).map(offer => [`${offer.currency}:${offer.amountMinor}`, offer.credits]));
const managed = project => typeof project === 'string' && project.startsWith('cp_');
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);

export function packCredits(amountMinor, currency = 'usd') {
  return Number.isSafeInteger(amountMinor) && typeof currency === 'string' ? PACKAGES.get(`${currency}:${amountMinor}`) ?? null : null;
}

export async function initPurchases(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paid_credit_grants (
      id bigserial PRIMARY KEY,
      project text NOT NULL REFERENCES control_credit_accounts (project),
      account_id text NOT NULL,
      mode text NOT NULL CHECK (mode = 'live'),
      checkout_session_id text NOT NULL,
      payment_intent_id text NOT NULL,
      credits bigint,
      amount_minor integer CHECK (amount_minor > 0),
      currency text CHECK (currency IN ('usd', 'inr')),
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      UNIQUE (account_id, mode, checkout_session_id),
      UNIQUE (account_id, mode, payment_intent_id),
      UNIQUE (id, project),
      CONSTRAINT paid_credit_grants_shape_check CHECK (
        (credits BETWEEN 1 AND 1000000 AND amount_minor IS NOT NULL AND currency IS NOT NULL)
        OR (credits IS NULL AND amount_minor IS NULL AND currency IS NULL AND revoked_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS paid_credit_grants_project ON paid_credit_grants (project, id);
    CREATE TABLE IF NOT EXISTS paid_credit_payment_holds (
      project text NOT NULL REFERENCES control_credit_accounts (project),
      account_id text NOT NULL,
      mode text NOT NULL CHECK (mode = 'live'),
      hold_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      cleared_at timestamptz,
      PRIMARY KEY (account_id, mode, hold_id)
    );
    CREATE INDEX IF NOT EXISTS paid_credit_payment_holds_active ON paid_credit_payment_holds (project) WHERE cleared_at IS NULL;
  `);
}

// Brings a grants table from the old releases to the shape above: USD-only
// currency becomes USD or INR, and the trial grants the old unified-credit
// upgrade copied in (source = 'signup_trial') go, because the trial is counted
// from control_credit_accounts. Runs inside Store.migrateLegacy's transaction.
export async function migrateLegacyGrants(client) {
  const currency = (await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'paid_credit_grants'::regclass AND conname = 'paid_credit_grants_currency_check'`)).rows[0]?.definition;
  if (currency === "CHECK ((currency = 'usd'::text))") {
    await client.query(`ALTER TABLE paid_credit_grants DROP CONSTRAINT paid_credit_grants_currency_check,
      ADD CONSTRAINT paid_credit_grants_currency_check CHECK (currency IN ('usd', 'inr'))`);
  }
  const hasSource = (await client.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'paid_credit_grants' AND column_name = 'source'`)).rowCount > 0;
  if (!hasSource) return;
  await client.query("DELETE FROM paid_credit_grants WHERE source = 'signup_trial'");
  // Dropping the column also drops its check constraint and partial index.
  await client.query(`ALTER TABLE paid_credit_grants DROP COLUMN source,
    ALTER COLUMN account_id SET NOT NULL, ALTER COLUMN mode SET NOT NULL,
    ALTER COLUMN checkout_session_id SET NOT NULL, ALTER COLUMN payment_intent_id SET NOT NULL,
    ADD CONSTRAINT paid_credit_grants_shape_check CHECK (
      (credits BETWEEN 1 AND 1000000 AND amount_minor IS NOT NULL AND currency IS NOT NULL)
      OR (credits IS NULL AND amount_minor IS NULL AND currency IS NULL AND revoked_at IS NOT NULL))`);
}

async function lockAccount(client, project) {
  const account = (await client.query('SELECT project FROM control_credit_accounts WHERE project = $1 FOR UPDATE', [project])).rows[0];
  if (!account) fail('credit_account_unavailable', 503);
}

const paidIdentity = ({project, mode, accountId}) => managed(project) && mode === 'live' && matches(accountId, ACCOUNT);
const checkoutIdentity = input => paidIdentity(input) && matches(input.checkoutSessionId, SESSION) && matches(input.paymentIntentId, INTENT);

async function existingGrant(client, input, key) {
  const {rows} = await client.query(`SELECT * FROM paid_credit_grants WHERE account_id = $1 AND mode = $2
    AND (checkout_session_id = $3 OR payment_intent_id = $4)`, key);
  const row = rows[0];
  if (rows.length !== 1 || row.project !== input.project || row.checkout_session_id !== input.checkoutSessionId
    || row.payment_intent_id !== input.paymentIntentId) fail('paid_credit_grant_conflict', 409);
  return row;
}

export class Purchases {
  constructor({store}) { this.store = store; }

  async grantPaidCredits(client, input) {
    const {project, mode, accountId, checkoutSessionId, paymentIntentId, credits, amountMinor, currency} = input;
    if (!checkoutIdentity(input) || !['usd', 'inr'].includes(currency) || packCredits(amountMinor, currency) !== credits) {
      fail('paid_credit_grant_invalid', 503);
    }
    await lockAccount(client, project);
    const key = [accountId, mode, checkoutSessionId, paymentIntentId];
    const inserted = await client.query(`INSERT INTO paid_credit_grants (account_id, mode, checkout_session_id, payment_intent_id, project,
      credits, amount_minor, currency) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [...key, project, credits, amountMinor, currency]);
    if (inserted.rowCount) return true;
    const row = await existingGrant(client, input, key);
    if (row.credits === null) fail('paid_credit_grant_reversed', 409);
    if (Number(row.credits) !== credits || row.amount_minor !== amountMinor || row.currency !== currency) fail('paid_credit_grant_conflict', 409);
    return false;
  }

  async revokePaidCredits(client, input) {
    if (!checkoutIdentity(input)) fail('paid_credit_grant_invalid', 503);
    const {project, accountId, mode, checkoutSessionId, paymentIntentId} = input;
    await lockAccount(client, project);
    const key = [accountId, mode, checkoutSessionId, paymentIntentId];
    // An early reversal reserves both payment identifiers, so a racing grant
    // sees the same row.
    const inserted = await client.query(`INSERT INTO paid_credit_grants (account_id, mode, checkout_session_id, payment_intent_id, project,
      revoked_at) VALUES ($1, $2, $3, $4, $5, clock_timestamp()) ON CONFLICT DO NOTHING`, [...key, project]);
    if (inserted.rowCount) return false;
    const row = await existingGrant(client, input, key);
    if (row.credits === null) return false;
    await client.query('UPDATE paid_credit_grants SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE id = $1', [row.id]);
    return true;
  }

  async setPaymentHold(client, input) {
    const {project, mode, accountId, holdId, active} = input;
    if (!paidIdentity(input) || !matches(holdId, HOLD) || typeof active !== 'boolean') fail('paid_credit_payment_hold_invalid', 503);
    await lockAccount(client, project);
    const result = await client.query(`INSERT INTO paid_credit_payment_holds (project, account_id, mode, hold_id, cleared_at)
      VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN NULL ELSE clock_timestamp() END)
      ON CONFLICT (account_id, mode, hold_id) DO UPDATE SET cleared_at = COALESCE(paid_credit_payment_holds.cleared_at, EXCLUDED.cleared_at)
      WHERE paid_credit_payment_holds.project = EXCLUDED.project`, [project, accountId, mode, holdId, active]);
    if (!result.rowCount) fail('paid_credit_payment_hold_conflict', 409);
  }

  async paymentHeld(project, client = this.store.pool) {
    return (await client.query('SELECT 1 FROM paid_credit_payment_holds WHERE project = $1 AND cleared_at IS NULL LIMIT 1', [project])).rowCount > 0;
  }
}
