// Trial credits: every verified user gets one trial grant, credited to their
// oldest active project. The receipt is per user, so deleting and recreating
// projects never grants twice. control_credit_accounts is also the row every
// project's balance hangs off (see ledger.mjs).
import {fail} from '../policy.mjs';
import {budget} from '../budgets.mjs';

export const TRIAL_CREDITS_PER_ACCOUNT = 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const amount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const managed = project => typeof project === 'string' && project.startsWith('cp_');

// A budget (src/budgets.mjs): config, or the admin portal, up to 1,000.
export function trialCredits(config) {
  const credits = budget(config, 'billing.trialCredits');
  if (!amount(credits) || credits > TRIAL_CREDITS_PER_ACCOUNT) fail('credit_policy_invalid', 503);
  return credits;
}

export async function initTrialAccounts(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_credit_accounts (
      project text PRIMARY KEY,
      granted_credits bigint NOT NULL CHECK (granted_credits >= 0 AND granted_credits <= 1000000000),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS control_trial_grant_receipts (
      user_id uuid NOT NULL REFERENCES control_users (id) ON DELETE CASCADE,
      target_credits bigint NOT NULL CHECK (target_credits BETWEEN 0 AND 1000),
      project text NOT NULL,
      prior_granted bigint NOT NULL CHECK (prior_granted >= 0),
      granted_credits bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (user_id, target_credits),
      CHECK (granted_credits = GREATEST(target_credits - prior_granted, 0))
    );
  `);
}

// Opens the project's account. Never tops up an existing one.
export async function openAccount(client, project) {
  if (!managed(project)) fail('credit_grant_invalid', 503);
  await client.query('INSERT INTO control_credit_accounts (project, granted_credits) VALUES ($1, 0) ON CONFLICT DO NOTHING', [project]);
}

// Grants the user's trial (once) to their oldest active project.
export async function grantTrial(client, {userId, targetCredits}) {
  if (typeof userId !== 'string' || !UUID.test(userId) || !amount(targetCredits) || targetCredits > TRIAL_CREDITS_PER_ACCOUNT) {
    fail('credit_grant_invalid', 503);
  }
  if (!(await client.query('SELECT id FROM control_users WHERE id = $1 FOR UPDATE', [userId])).rowCount) fail('unauthorized', 401);
  const existing = (await client.query('SELECT project FROM control_trial_grant_receipts WHERE user_id = $1 AND target_credits = $2',
    [userId, targetCredits])).rows[0];
  if (existing) return {project: existing.project, granted: 0, replayed: true};
  const project = (await client.query(`SELECT id FROM control_projects WHERE user_id = $1 AND status = 'active' AND left(id, 3) = 'cp_'
    ORDER BY created_at, id LIMIT 1 FOR SHARE`, [userId])).rows[0]?.id;
  if (!project) return null;
  // Credits from any earlier trial count toward the target.
  const prior = BigInt((await client.query(`SELECT GREATEST(
      (SELECT COALESCE(sum(a.granted_credits), 0) FROM control_credit_accounts a JOIN control_projects p ON p.id = a.project
        WHERE p.user_id = $1 AND left(p.id, 3) = 'cp_'),
      (SELECT COALESCE(max(prior_granted + granted_credits), 0) FROM control_trial_grant_receipts WHERE user_id = $1)) AS credits`,
  [userId])).rows[0].credits);
  const add = prior < BigInt(targetCredits) ? Number(BigInt(targetCredits) - prior) : 0;
  await openAccount(client, project);
  if (add > 0) await client.query('UPDATE control_credit_accounts SET granted_credits = granted_credits + $2 WHERE project = $1', [project, add]);
  await client.query(`INSERT INTO control_trial_grant_receipts (user_id, target_credits, project, prior_granted, granted_credits)
    VALUES ($1, $2, $3, $4, $5)`, [userId, targetCredits, project, prior.toString(), add]);
  return {project, granted: add, replayed: false};
}
