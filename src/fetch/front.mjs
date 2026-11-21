// The platform side of POST /v1/fetch: everything about a fetch except doing
// it. The engine (karthikbala/fetchx-engine) fetches; this module decides what
// a job may cost, reserves credits for it, settles it exactly once when it
// finishes, and serves results to the project that owns them.
//
//   submit   reserve (in one transaction with a pending settlement row), send
//            the job with the cost tiers the reservation covers, settle at once
//            if it finished, release if the engine refused it.
//   settle   once per job id: charge the winning step's price (at most the
//            reservation) or release; queue the customer webhook.
//   reconcile   settle jobs whose event never came, and release reservations
//            for jobs the engine never started.
//
// The engine never sees prices, credits or users: only the project id as an
// opaque tenant, and allowed_steps.
import {randomBytes, randomUUID} from 'node:crypto';
import {GatewayError, fail} from '../policy.mjs';
import {Sealer} from '../crypto.mjs';
import {STEPS, priceOf, priceParts, worstCaseOf} from '../billing/ledger.mjs';
import {budget} from '../budgets.mjs';

// Credits one request may reserve and requests at once per project are
// budgets (src/budgets.mjs), adjustable in the admin portal.
export const DEFAULT_LIMITS = Object.freeze({
  maxCredits: 100_000,
  // The engine's response cap; the worst case of a residential step pays for it.
  maxWireBytes: 30_000_000,
  // A job's deadline before the engine answers (its longest timeout_ms, 180 s, plus slack).
  provisionalDeadlineMs: 200_000,
  // How long after its deadline a job with no event is looked up.
  settleGraceMs: 30_000,
  metadataDays: 90,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function initFetchFront(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fetch_settlements (
      request uuid PRIMARY KEY,
      project text NOT NULL,
      key_id text,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
      error_code text,
      step text,
      captcha boolean NOT NULL DEFAULT false,
      credits_max bigint,
      credits_charged bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      deadline timestamptz,
      settled_at timestamptz
    );
    -- The winning step's wire bytes, for the price breakdown results show.
    ALTER TABLE fetch_settlements ADD COLUMN IF NOT EXISTS wire_bytes bigint;
    CREATE INDEX IF NOT EXISTS fetch_settlements_project_created ON fetch_settlements (project, created_at);
    CREATE INDEX IF NOT EXISTS fetch_settlements_pending ON fetch_settlements (deadline) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS webhook_secrets (
      project text PRIMARY KEY,
      secret bytea NOT NULL,
      rotated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      request uuid PRIMARY KEY REFERENCES fetch_settlements (request) ON DELETE CASCADE,
      project text NOT NULL,
      url bytea NOT NULL,
      attempts int NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      delivered_at timestamptz,
      gave_up_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (next_attempt_at)
      WHERE delivered_at IS NULL AND gave_up_at IS NULL;
  `);
}

const invalid = (field, reason) => Object.assign(new GatewayError('invalid_request', 400), {details: {field, ...(reason ? {reason} : {})}});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class FetchFront {
  // engine: an EngineClient. onSettled(id) runs after a settlement that queued a webhook.
  constructor({store, config, ledger, engine, limits = {}, onSettled = () => {}}) {
    Object.assign(this, {store, config, ledger, engine, onSettled});
    this.limits = {...DEFAULT_LIMITS, ...config.fetchLimits, ...limits};
    this.sealer = new Sealer(config.sealingKey);
  }

  // ---------- admission ----------

  // What the platform itself checks: the parts of the request it bills from.
  // Everything else is the engine's to validate.
  #billingInput(raw) {
    if (!plain(raw)) throw invalid('body');
    const maxCredits = raw.max_credits ?? null;
    if (maxCredits !== null && (!Number.isSafeInteger(maxCredits) || maxCredits < 1 || maxCredits > this.limits.maxCredits)) {
      throw invalid('max_credits', `1 to ${this.limits.maxCredits}`);
    }
    const method = typeof raw.method === 'string' ? raw.method.toUpperCase() : 'GET';
    return {maxCredits, method};
  }

  // The most any step could cost this request: the ceiling of its reservation.
  #ceiling({maxCredits, method}) {
    const table = this.ledger.prices;
    const worst = Math.max(...STEPS.map(step => worstCaseOf(table, step, {captcha: method === 'GET', maxWireBytes: this.limits.maxWireBytes})));
    return Math.min(maxCredits ?? Infinity, worst, budget(this.config, 'fetch.maxCreditsPerRequest'));
  }

  async submit(project, raw, {keyId = null} = {}) {
    const billing = this.#billingInput(raw);
    const id = randomUUID();
    const table = this.ledger.prices;
    const metered = this.ledger.metered(project);
    // Why allowed_steps is empty, so the engine's budget_too_low can be told
    // back to the caller as the reason it really is. Refusing here instead would
    // stop idempotent replays of finished jobs from returning their results.
    const admission = {reserved: null, available: null, held: false, busy: null};
    let allowed = null;
    await this.store.tx(async client => {
      await this.ledger.lock(client, project);
      const running = (await client.query(`SELECT count(*)::int AS n FROM fetch_settlements WHERE project = $1 AND status = 'pending'`,
        [project])).rows[0].n;
      await client.query(`INSERT INTO fetch_settlements (request, project, key_id, deadline) VALUES ($1, $2, $3, clock_timestamp() + make_interval(secs => $4))`,
        [id, project, keyId, this.limits.provisionalDeadlineMs / 1000]);
      const cap = this.config.projects?.[project]?.maxConcurrentRequests ?? budget(this.config, 'fetch.maxConcurrentPerProject');
      if (running >= cap) {
        admission.busy = running;
        allowed = [];
        return;
      }
      if (!metered) return;
      const balance = await this.ledger.balance(project, client);
      admission.available = balance.available;
      if (balance.held) {
        admission.held = true;
        allowed = [];
        return;
      }
      const credits = Math.min(this.#ceiling(billing), balance.available);
      if (credits >= 1) {
        await this.ledger.hold(client, {project, request: id, credits});
        await client.query('UPDATE fetch_settlements SET credits_max = $2 WHERE request = $1', [id, credits]);
        admission.reserved = credits;
      }
      allowed = STEPS.filter(step => table[step] <= (admission.reserved ?? 0));
    });

    let answer;
    try {
      answer = await this.engine.startJob({id, tenant: project, request: raw, allowed_steps: allowed});
    } catch (error) {
      // Refused, or never sent: nothing ran, so nothing is owed. A call that
      // may have reached the engine stays pending for the reconciler.
      if (error.fromEngine || error.sent === false) await this.#discard(id);
      if (error.code === 'budget_too_low') throw this.#budgetError(error, billing, admission);
      if (error.code === 'job_id_conflict') fail('unavailable', 503);
      throw error;
    }
    const {envelope} = answer;
    if (envelope.created === false) {
      // The idempotency key already has a job: show that one, start nothing.
      await this.#discard(id);
      return this.#viewOf(project, envelope);
    }
    await this.store.pool.query('UPDATE fetch_settlements SET deadline = $2 WHERE request = $1 AND status = $3',
      [id, envelope.deadline, 'pending']);
    return this.#viewOf(project, envelope);
  }

  #budgetError(error, {maxCredits}, {held, busy, available}) {
    if (busy !== null) return Object.assign(new GatewayError('too_many_requests', 429), {details: {retry_after_seconds: 5, running: busy}});
    if (held) return new GatewayError('payment_hold', 402);
    const table = this.ledger.prices;
    const planned = (error.details?.planned_steps ?? []).filter(step => STEPS.includes(step));
    const minimum = Math.min(...(planned.length ? planned : STEPS).map(step => table[step]));
    // The request's own max_credits, or the per-request budget, is below the cheapest planned step.
    if (Math.min(maxCredits ?? Infinity, budget(this.config, 'fetch.maxCreditsPerRequest')) < minimum) {
      return Object.assign(new GatewayError('max_credits_too_low', 402), {details: {min_credits: minimum}});
    }
    return Object.assign(new GatewayError('insufficient_credits', 402), {details: {available: available ?? 0, needed: minimum}});
  }

  // Drops a job that never started: its reservation and its settlement row.
  async #discard(id) {
    await this.store.tx(async client => {
      await this.ledger.release(client, {request: id});
      await client.query(`DELETE FROM fetch_settlements WHERE request = $1 AND status = 'pending'`, [id]);
    });
  }

  // ---------- settlement ----------

  // Settles a finished job once: charges the winning step (never more than the
  // reservation) or releases it, and queues the webhook. A job the platform
  // does not know, or one for another project, is ignored. Returns the row.
  async settle(id, {tenant, status, error_code: errorCode = null, usage = null, webhook_url: webhookUrl = null}) {
    if (!UUID.test(id ?? '') || !['succeeded', 'failed'].includes(status)) return null;
    let queued = false;
    const row = await this.store.tx(async client => {
      const current = (await client.query('SELECT * FROM fetch_settlements WHERE request = $1 FOR UPDATE', [id])).rows[0];
      if (!current || (tenant !== undefined && current.project !== tenant)) return null;
      if (current.status !== 'pending') return current;
      let charged = 0;
      const step = status === 'succeeded' && STEPS.includes(usage?.step) ? usage.step : null;
      const captcha = step !== null && usage.captcha_solved === true;
      const wireBytes = step !== null && Number.isSafeInteger(usage.wire_bytes) && usage.wire_bytes >= 0 ? usage.wire_bytes : null;
      if (step && this.ledger.metered(current.project) && current.credits_max !== null) {
        const price = priceOf(this.ledger.prices, {step, captchaSolved: captcha, wireBytes: wireBytes ?? 0});
        charged = await this.ledger.charge(client, {project: current.project, request: id, step,
          credits: Math.min(price, Number(current.credits_max)), captcha});
      } else {
        await this.ledger.release(client, {request: id});
      }
      const updated = (await client.query(`UPDATE fetch_settlements SET status = $2, error_code = $3, step = $4, captcha = $5,
        credits_charged = $6, wire_bytes = $7, settled_at = clock_timestamp() WHERE request = $1 RETURNING *`,
      [id, status, status === 'succeeded' ? null : errorCode, step, captcha, charged, wireBytes])).rows[0];
      if (typeof webhookUrl === 'string' && webhookUrl) {
        await client.query('INSERT INTO webhook_deliveries (request, project, url) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [id, current.project, this.sealer.seal(webhookUrl)]);
        queued = true;
      }
      return updated;
    });
    if (queued) this.onSettled(id);
    return row;
  }

  // Jobs whose event has not come by their deadline (plus grace) are read from
  // the engine: finished ones are settled, unknown ones were never started and
  // their reservation is released.
  async reconcile({limit = 100} = {}) {
    const rows = (await this.store.pool.query(`SELECT request, project FROM fetch_settlements WHERE status = 'pending'
      AND deadline < clock_timestamp() - make_interval(secs => $1) ORDER BY deadline LIMIT $2`,
    [this.limits.settleGraceMs / 1000, limit])).rows;
    let settled = 0;
    for (const row of rows) {
      try {
        const envelope = await this.engine.getJob(row.project, row.request, {includeBody: false});
        if (envelope.job.status !== 'pending') {
          await this.settle(row.request, {tenant: row.project, status: envelope.job.status, error_code: envelope.job.error?.code ?? null,
            usage: envelope.usage, webhook_url: envelope.webhook_url});
          settled++;
        }
      } catch (error) {
        if (error.code === 'not_found') {
          await this.#discard(row.request);
          settled++;
        }
        // Anything else (the engine is down): try again next pass.
      }
    }
    return settled;
  }

  // ---------- reading ----------

  async #settlementsFor(ids) {
    if (!ids.length) return new Map();
    const rows = (await this.store.pool.query('SELECT * FROM fetch_settlements WHERE request = ANY($1::uuid[])', [ids])).rows;
    return new Map(rows.map(row => [row.request, row]));
  }

  // The public FetchResult: the engine's job plus what it cost. A finished job
  // whose settlement is still pending (its event is on the way) is settled now.
  async #viewOf(project, envelope) {
    const {job} = envelope;
    let settlement = (await this.#settlementsFor([job.id])).get(job.id) ?? null;
    if (settlement?.status === 'pending' && job.status !== 'pending') {
      settlement = await this.settle(job.id, {tenant: project, status: job.status, error_code: job.error?.code ?? null,
        usage: envelope.usage, webhook_url: envelope.webhook_url}) ?? settlement;
    }
    const credits = {charged: Number(settlement?.credits_charged ?? 0),
      max: settlement?.credits_max === null || settlement?.credits_max === undefined ? null : Number(settlement.credits_max),
      balance: (await this.ledger.balance(project))?.available ?? null,
      breakdown: this.#breakdownOf(settlement)};
    const {id, status, page_status: pageStatus = null, idempotency_key: key, url, created_at: createdAt, finished_at: finishedAt, tags, data,
      challenge = null, attempts, skipped, fixes, error, ...extra} = job;
    return {id, status, page_status: pageStatus, idempotency_key: key, url, created_at: createdAt, finished_at: finishedAt, tags, data,
      credits, challenge, attempts, skipped, fixes, error, ...extra};
  }

  // How the price of the step that got the data adds up (shown for unmetered
  // projects too, which are not charged it). Null unless the job succeeded.
  #breakdownOf(settlement) {
    if (settlement?.status !== 'succeeded' || !STEPS.includes(settlement.step) || settlement.wire_bytes === null
      || settlement.wire_bytes === undefined) return null;
    return priceParts(this.ledger.prices, {step: settlement.step, captchaSolved: settlement.captcha, wireBytes: Number(settlement.wire_bytes)});
  }

  // The project's credits now, for GET /v1/balance.
  async balance(project) {
    const balance = await this.ledger.balance(project);
    return balance ? {credits: balance.available, reserved: balance.reserved, trial: balance.trial, purchased: balance.purchased,
      payment_hold: balance.held} : {credits: null, reserved: 0, trial: 0, purchased: 0, payment_hold: false};
  }

  async get(project, id, {includeBody = true} = {}) {
    return this.#viewOf(project, await this.engine.getJob(project, id, {includeBody}));
  }

  async list(project, query = {}) {
    const page = await this.engine.listJobs(project, query);
    const settlements = await this.#settlementsFor(page.items.map(item => item.id));
    return {...page, items: page.items.map(({id, status, url, created_at: createdAt, ...rest}) => ({id, status, url, created_at: createdAt,
      credits: {charged: Number(settlements.get(id)?.credits_charged ?? 0)}, ...rest}))};
  }

  async content(project, id, kind = 'body') {
    return this.engine.content(project, id, kind === 'body' ? 'content' : 'screenshot');
  }

  async remove(project, id) {
    await this.engine.remove(project, id);
  }

  // How many of a project's jobs finished in a period, for /v1/usage.
  async counts(project, {from, to}) {
    return (await this.store.pool.query(`SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        count(*) FILTER (WHERE status = 'failed')::int AS failed FROM fetch_settlements
      WHERE project = $1 AND created_at >= $2 AND created_at < $3`, [project, from, to])).rows[0];
  }

  // ---------- webhooks and retention ----------

  async webhookSecret(project, {rotate = false} = {}) {
    const existing = (await this.store.pool.query('SELECT secret FROM webhook_secrets WHERE project = $1', [project])).rows[0];
    if (existing && !rotate) return this.sealer.open(existing.secret);
    const secret = 'whsec_' + randomBytes(24).toString('base64url');
    await this.store.pool.query(`INSERT INTO webhook_secrets (project, secret) VALUES ($1, $2)
      ON CONFLICT (project) DO UPDATE SET secret = EXCLUDED.secret, rotated_at = now()`, [project, this.sealer.seal(secret)]);
    return secret;
  }

  // Settled jobs are kept as long as the engine keeps the job itself.
  async prune() {
    await this.store.pool.query(`DELETE FROM fetch_settlements WHERE status <> 'pending'
      AND created_at < now() - make_interval(days => $1)`, [this.limits.metadataDays]);
  }
}
