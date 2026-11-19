// CAPTCHA solving through 2captcha (API v2). The API key stays in the gateway
// process: browser workers ask for a solution over the callback channel and
// never see it. Every task is reserved against FetchX's own spending limits
// before it is created, and an uncertain task creation is never repeated.
//
// Supported:
//   turnstile     TurnstileTaskProxyless       -> token
//   recaptcha_v2  RecaptchaV2TaskProxyless     -> token
//   datadome      DataDomeSliderTask (+proxy)  -> datadome cookie
//   grid          GridTask (image tiles)       -> tiles to click (used for hCaptcha)
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {GatewayError, fail} from '../policy.mjs';
import {budget} from '../budgets.mjs';

export const CAPTCHA_KINDS = Object.freeze(['turnstile', 'recaptcha_v2', 'datadome', 'grid']);
const SITE_KEY = /^[A-Za-z0-9_-]{10,200}$/;
const ACCOUNT_ERRORS = new Set(['ERROR_KEY_DOES_NOT_EXIST', 'ERROR_ZERO_BALANCE', 'ERROR_ACCOUNT_SUSPENDED', 'ERROR_IP_NOT_ALLOWED']);
const MAX_GRID_IMAGE_BYTES = 600_000;

export async function initCaptchaSolves(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS captcha_solves (
      id uuid PRIMARY KEY,
      request uuid NOT NULL,
      project text NOT NULL,
      kind text NOT NULL,
      host text NOT NULL,
      provider_task_id text,
      state text NOT NULL DEFAULT 'reserved',
      reserved_micro_usd bigint NOT NULL,
      actual_micro_usd bigint,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS captcha_solves_project_created ON captcha_solves (project, created_at);
    CREATE INDEX IF NOT EXISTS captcha_solves_request ON captcha_solves (request);
  `);
}

export function microUsd(value) {
  if (typeof value !== 'string' || !/^\d{1,6}(?:\.\d{1,6})?$/.test(value)) fail('captcha_cost_unverified', 502);
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
}

const bounded = (value, max) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('captcha_budget_unconfigured', 503);
  return value;
};

// The spending limits are budgets (src/budgets.mjs): set in config, adjustable
// from the admin portal within their hard bounds, and read on every task.
export function captchaSettings(config) {
  const settings = config.captcha;
  if (!settings?.enabled || !settings.apiKey) return null;
  return {
    apiKey: settings.apiKey,
    maxTaskMicroUsd: budget(config, 'captcha.maxTaskMicroUsd'),
    maxDailyMicroUsd: budget(config, 'captcha.maxDailyMicroUsd'),
    maxTotalMicroUsd: budget(config, 'captcha.maxTotalMicroUsd'),
    maxProjectDailyMicroUsd: budget(config, 'captcha.maxProjectDailyMicroUsd'),
    maxTotalTasks: budget(config, 'captcha.maxTotalTasks'),
    maxTasksPerRequest: budget(config, 'captcha.maxTasksPerRequest'),
    timeoutMs: bounded(settings.timeoutMs ?? 120_000, 180_000),
    // DataDome needs our proxy passed to 2captcha; opt-in.
    datadome: settings.datadome === true,
  };
}

export class CaptchaSolver {
  constructor(store, config, {fetchImpl = fetch, wait = sleep, now = Date.now} = {}) {
    Object.assign(this, {store, config, fetchImpl, wait, now});
  }

  get settings() { return captchaSettings(this.config); }

  supports(kind) {
    const settings = this.settings;
    return !!settings && CAPTCHA_KINDS.includes(kind) && (kind !== 'datadome' || settings.datadome);
  }

  async post(method, body, signal) {
    try {
      const response = await this.fetchImpl('https://api.2captcha.com/' + method, {
        method: 'POST',
        redirect: 'error',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({clientKey: this.settings.apiKey, ...body}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error('http');
      let raw = '';
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 65536) throw new Error('too large');
        raw += Buffer.from(chunk).toString('utf8');
      }
      const data = JSON.parse(raw);
      if (!data || !Number.isInteger(data.errorId) || data.errorId < 0) throw new Error('shape');
      return data;
    } catch {
      fail('captcha_provider_outcome_unknown', 502);
    }
  }

  // Reserves the task's maximum cost against every limit, atomically.
  async reserve({request, project, kind, host}) {
    const settings = this.settings;
    const id = randomUUID();
    await this.store.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(1009)');
      const held = await client.query(`SELECT 1 FROM captcha_solves WHERE error IN ('captcha_account_rejected', 'captcha_cost_overrun') LIMIT 1`);
      if (held.rowCount) fail('captcha_account_held', 409);
      const used = (await client.query(`
        SELECT count(*)::int AS tasks,
          count(*) FILTER (WHERE request = $2)::int AS request_tasks,
          COALESCE(sum(COALESCE(actual_micro_usd, reserved_micro_usd)), 0)::bigint AS total,
          COALESCE(sum(COALESCE(actual_micro_usd, reserved_micro_usd)) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::bigint AS daily,
          COALESCE(sum(COALESCE(actual_micro_usd, reserved_micro_usd)) FILTER (WHERE project = $1 AND created_at > now() - interval '24 hours'), 0)::bigint AS project
        FROM captcha_solves`, [project, request])).rows[0];
      const projectDaily = this.config.projects?.[project]?.maxDailyCaptchaMicroUsd ?? settings.maxProjectDailyMicroUsd
        ?? settings.maxDailyMicroUsd;
      const maximum = settings.maxTaskMicroUsd;
      if (used.request_tasks >= settings.maxTasksPerRequest || used.tasks >= settings.maxTotalTasks
        || Number(used.total) + maximum > settings.maxTotalMicroUsd || Number(used.daily) + maximum > settings.maxDailyMicroUsd
        || Number(used.project) + maximum > projectDaily) {
        fail('captcha_budget_exhausted', 429);
      }
      await client.query(`INSERT INTO captcha_solves (id, request, project, kind, host, reserved_micro_usd)
        VALUES ($1, $2, $3, $4, $5, $6)`, [id, request, project, kind, host, maximum]);
    });
    return {id, maximum: settings.maxTaskMicroUsd};
  }

  task(kind, input) {
    if (kind === 'turnstile' || kind === 'recaptcha_v2') {
      if (!SITE_KEY.test(input.siteKey ?? '')) fail('captcha_request_invalid', 400);
      return kind === 'turnstile'
        ? {type: 'TurnstileTaskProxyless', websiteURL: input.websiteURL, websiteKey: input.siteKey}
        : {type: 'RecaptchaV2TaskProxyless', websiteURL: input.websiteURL, websiteKey: input.siteKey,
          isInvisible: input.invisible === true, userAgent: input.userAgent};
    }
    if (kind === 'datadome') {
      let captchaUrl;
      try { captchaUrl = new URL(input.captchaUrl); } catch { fail('captcha_request_invalid', 400); }
      if (!/(^|\.)captcha-delivery\.com$/.test(captchaUrl.hostname)) fail('captcha_request_invalid', 400);
      // t=bv means DataDome has banned this IP; solving cannot help.
      if (captchaUrl.searchParams.get('t') === 'bv') fail('captcha_ip_banned', 409);
      const proxy = new URL(input.proxyUrl ?? '');
      if (proxy.protocol !== 'http:') fail('captcha_request_invalid', 400);
      return {type: 'DataDomeSliderTask', websiteURL: input.websiteURL, captchaUrl: captchaUrl.href, userAgent: input.userAgent,
        proxyType: 'http', proxyAddress: proxy.hostname, proxyPort: proxy.port || '80',
        ...(proxy.username ? {proxyLogin: decodeURIComponent(proxy.username), proxyPassword: decodeURIComponent(proxy.password)} : {})};
    }
    if (kind === 'grid') {
      if (typeof input.image !== 'string' || Buffer.byteLength(input.image) > MAX_GRID_IMAGE_BYTES * 1.4) fail('captcha_request_invalid', 400);
      const rows = input.rows ?? 3;
      const columns = input.columns ?? 3;
      if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1 || rows * columns > 16) {
        fail('captcha_request_invalid', 400);
      }
      return {type: 'GridTask', body: input.image, comment: String(input.instructions ?? '').slice(0, 300), rows, columns,
        canNoAnswer: 1};
    }
    fail('captcha_unsupported', 400);
  }

  solution(kind, data) {
    const solution = data.solution ?? {};
    if (kind === 'turnstile' || kind === 'recaptcha_v2') {
      const token = kind === 'turnstile' ? solution.token : solution.gRecaptchaResponse;
      if (typeof token !== 'string' || !/^\S{20,16384}$/.test(token)) fail('captcha_solution_invalid', 502);
      return {token};
    }
    if (kind === 'datadome') {
      if (typeof solution.cookie !== 'string' || !/^datadome=[^;\s]{10,4096}/.test(solution.cookie)) fail('captcha_solution_invalid', 502);
      return {cookie: solution.cookie};
    }
    // grid
    if (solution.text === 'No_matching_images' || solution.click === 'No_matching_images') return {click: []};
    if (!Array.isArray(solution.click) || solution.click.some(n => !Number.isSafeInteger(n) || n < 1 || n > 16)) {
      fail('captcha_solution_invalid', 502);
    }
    return {click: solution.click};
  }

  // input: {request, project, websiteURL, ...per kind}
  async solve(kind, input, {signal} = {}) {
    if (!this.supports(kind)) fail('captcha_unsupported', 400);
    let website;
    try { website = new URL(input.websiteURL); } catch { fail('captcha_request_invalid', 400); }
    if (!['http:', 'https:'].includes(website.protocol) || website.username) fail('captcha_request_invalid', 400);
    if (typeof input.userAgent !== 'string' || !input.userAgent || input.userAgent.length > 512) fail('captcha_request_invalid', 400);
    const task = this.task(kind, input);
    const reservation = await this.reserve({request: input.request, project: input.project, kind, host: website.hostname});
    let state = 'unknown';
    let actual = null;
    let error = null;
    try {
      const created = await this.post('createTask', {task}, signal);
      if (created.errorId) {
        state = 'rejected';
        actual = 0;
        fail(ACCOUNT_ERRORS.has(created.errorCode) ? 'captcha_account_rejected' : 'captcha_task_rejected', 503);
      }
      if (!Number.isSafeInteger(created.taskId) || created.taskId <= 0) fail('captcha_provider_outcome_unknown', 502);
      await this.store.pool.query(`UPDATE captcha_solves SET provider_task_id = $2, state = 'processing', updated_at = now() WHERE id = $1`,
        [reservation.id, String(created.taskId)]);
      const deadline = this.now() + this.settings.timeoutMs;
      while (this.now() < deadline) {
        if (signal?.aborted) fail('captcha_cancelled', 409);
        await this.wait(kind === 'grid' ? 3000 : 5000, undefined, {signal});
        const data = await this.post('getTaskResult', {taskId: created.taskId}, signal);
        if (data.errorId) {
          state = 'failed';
          fail(data.errorCode === 'ERROR_CAPTCHA_UNSOLVABLE' ? 'captcha_unsolvable' : 'captcha_solver_failed', 502);
        }
        if (data.status === 'processing') continue;
        if (data.status !== 'ready') fail('captcha_provider_outcome_unknown', 502);
        actual = microUsd(data.cost);
        state = 'ready';
        if (actual > reservation.maximum) fail('captcha_cost_overrun', 503);
        return {...this.solution(kind, data), cost_micro_usd: actual};
      }
      fail('captcha_timeout', 504);
    } catch (caught) {
      error = caught instanceof GatewayError ? caught.code : 'captcha_provider_outcome_unknown';
      throw caught instanceof GatewayError ? caught : new GatewayError(error, 502);
    } finally {
      await this.store.pool.query(`UPDATE captcha_solves SET state = $2, actual_micro_usd = $3, error = $4, updated_at = now() WHERE id = $1`,
        [reservation.id, state, actual, error]);
    }
  }

  async recover() {
    await this.store.pool.query(`UPDATE captcha_solves SET state = 'unknown', error = 'captcha_interrupted_unknown', updated_at = now()
      WHERE state IN ('reserved', 'processing')`);
  }

  async status(project = null) {
    const usage = (await this.store.pool.query(`SELECT kind, state, count(*)::int AS tasks,
        COALESCE(sum(COALESCE(actual_micro_usd, reserved_micro_usd)), 0)::text AS accounted_micro_usd
      FROM captcha_solves WHERE ($1::text IS NULL OR project = $1) GROUP BY kind, state ORDER BY kind, state`, [project])).rows;
    return {configured: !!this.settings, kinds: CAPTCHA_KINDS.filter(kind => this.supports(kind)), usage};
  }
}
