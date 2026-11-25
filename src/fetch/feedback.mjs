// Feedback from callers about how FetchX handled a page (POST /v1/feedback),
// for example "this was blocked through FetchX but loads from my own
// connection". Each report names one request of the project (fetch_id) or a
// URL and method, says what was seen (kind), and may carry evidence from
// where it worked. When it names a request, what FetchX did (status, error,
// every attempt's transport, IP class, country and outcome) is copied in, so
// staff can still see it after the result itself has expired. FetchX staff
// read and answer reports in the admin portal; GET /v1/feedback/{id} shows the
// caller the report's status and staff's reply. Free; kept as long as request
// metadata (90 days).
import {randomUUID} from 'node:crypto';
import {GatewayError, fail} from '../policy.mjs';

export const FEEDBACK_KINDS = Object.freeze(['blocked_via_fetchx_ok_from_home', 'wrong_content', 'extract_wrong', 'other']);
export const FEEDBACK_STATUSES = Object.freeze(['received', 'reviewing', 'resolved', 'dismissed']);
const OPEN = ['received', 'reviewing'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
// Reports a project may send per UTC day.
export const FEEDBACK_PER_DAY = 100;
const MAX_ATTEMPTS = 12;
const LIMITS = {message: 2000, url: 2048, final_url: 2048, content_type: 200, body_excerpt: 4000, client: 200, reply: 2000};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;

export async function initFeedback(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fetch_feedback (
      id uuid PRIMARY KEY,
      project text NOT NULL,
      key_id text,
      kind text NOT NULL,
      fetch_id uuid,
      url text NOT NULL,
      -- Null for a report that names fetch_id, when the request's method is not known.
      method text,
      host text NOT NULL,
      message text,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      -- What FetchX did with fetch_id, copied when the report came in (staff only).
      fetch_record jsonb,
      status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'reviewing', 'resolved', 'dismissed')),
      reply text,
      reviewed_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS fetch_feedback_project_created ON fetch_feedback (project, created_at);
    CREATE INDEX IF NOT EXISTS fetch_feedback_created ON fetch_feedback (created_at);
  `);
}

const invalid = (field, reason) => Object.assign(new GatewayError('invalid_request', 400), {details: {field, reason}});
const iso = value => value ? new Date(value).toISOString() : null;

function text(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw invalid(field, `a string of at most ${max} characters`);
  return value.trim() || null;
}
function webUrl(value, field) {
  const raw = text(value, field, LIMITS.url);
  let url;
  try { url = raw && new URL(raw); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname) throw invalid(field, 'an http or https URL');
  return url;
}
function evidenceOf(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('evidence', 'an object');
  const known = ['status_code', 'final_url', 'content_type', 'body_excerpt', 'client'];
  const extra = Object.keys(value).find(key => !known.includes(key));
  if (extra) throw invalid(`evidence.${extra}`, `not a field; use ${known.join(', ')}`);
  const out = {};
  if (value.status_code !== undefined && value.status_code !== null) {
    if (!Number.isInteger(value.status_code) || value.status_code < 100 || value.status_code > 599) {
      throw invalid('evidence.status_code', 'an HTTP status from 100 to 599');
    }
    out.status_code = value.status_code;
  }
  if (value.final_url !== undefined && value.final_url !== null) out.final_url = webUrl(value.final_url, 'evidence.final_url').href;
  for (const field of ['content_type', 'body_excerpt', 'client']) {
    const checked = text(value[field], `evidence.${field}`, LIMITS[field]);
    if (checked !== null) out[field] = checked;
  }
  return out;
}

// What FetchX did with a request, as staff need it to tune routes.
function snapshotOf(job) {
  return {
    status: job.status ?? null, page_status: job.page_status ?? null, error_code: job.error?.code ?? null,
    challenge: job.challenge?.vendor ?? null, created_at: job.created_at ?? null, finished_at: job.finished_at ?? null,
    attempts: (Array.isArray(job.attempts) ? job.attempts : []).slice(0, MAX_ATTEMPTS).map(attempt => ({
      transport: attempt.transport ?? null, class: attempt.class ?? null, country: attempt.country ?? null, result: attempt.result ?? null,
      code: attempt.code ?? null, challenge: attempt.challenge ?? null, status_code: attempt.status_code ?? null})),
  };
}

// What the caller sees (POST and GET /v1/feedback).
const publicView = row => ({id: row.id, kind: row.kind, fetch_id: row.fetch_id ?? null, url: row.url, method: row.method ?? null, message: row.message ?? null,
  evidence: row.evidence ?? {}, status: row.status, reply: row.reply ?? null, created_at: iso(row.created_at), updated_at: iso(row.updated_at)});
// What staff see in the admin portal.
const adminView = row => ({...publicView(row), project: row.project, project_name: row.project_name ?? null, key_id: row.key_id ?? null,
  host: row.host, fetch: row.fetch_record ?? null, reviewed_by: row.reviewed_by ?? null});

export class FeedbackService {
  // metadataDays: how long request metadata is kept (FetchFront's limits).
  constructor({store, config, engine, metadataDays = 90}) {
    Object.assign(this, {store, config, engine, metadataDays});
  }

  // POST /v1/feedback. Returns {feedback, created}: an open report of the same
  // kind about the same request (or URL and method) is returned instead of a new one.
  async submit(project, input, {keyId = null} = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('body', 'a JSON object');
    const known = ['fetch_id', 'url', 'method', 'kind', 'message', 'evidence'];
    const extra = Object.keys(input).find(key => !known.includes(key));
    if (extra) throw invalid(extra, `not a field; use ${known.join(', ')}`);
    if (!FEEDBACK_KINDS.includes(input.kind)) throw invalid('kind', `one of ${FEEDBACK_KINDS.join(', ')}`);
    const message = text(input.message, 'message', LIMITS.message);
    const evidence = evidenceOf(input.evidence);
    let fetchId = null, url, method, snapshot = null;
    if (input.fetch_id !== undefined && input.fetch_id !== null) {
      if (typeof input.fetch_id !== 'string' || !UUID.test(input.fetch_id)) throw invalid('fetch_id', 'the id of one of your requests');
      if (input.url !== undefined || input.method !== undefined) throw invalid('url', 'give fetch_id or url, not both');
      // Throws not_found for a request that is not this project's, or no longer kept.
      const job = (await this.engine.getJob(project, input.fetch_id, {includeBody: false}))?.job;
      if (!job) throw new GatewayError('not_found', 404);
      // FetchX staff read feedback: nothing of a request made with secrets goes to them.
      if (Array.isArray(job.secrets_used)) {
        throw Object.assign(new GatewayError('secret_not_allowed_here', 400), {details: {field: 'fetch_id',
          reason: 'the request was made with secrets; describe it with url and method instead, without them'}});
      }
      fetchId = input.fetch_id;
      url = webUrl(job.url, 'fetch_id');
      method = METHODS.includes(job.method) ? job.method : null;
      snapshot = snapshotOf(job);
    } else {
      if (input.url === undefined || input.url === null) throw invalid('fetch_id', 'give fetch_id (a request of yours) or url');
      url = webUrl(input.url, 'url');
      method = input.method === undefined || input.method === null ? 'GET' : input.method;
      if (!METHODS.includes(method)) throw invalid('method', `one of ${METHODS.join(', ')}`);
    }
    return this.store.tx(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('fetch_feedback:' || $1))", [project]);
      const same = (await client.query(`SELECT * FROM fetch_feedback WHERE project = $1 AND kind = $2 AND status = ANY($3)
        AND (CASE WHEN $4::uuid IS NULL THEN fetch_id IS NULL AND url = $5 AND method = $6 ELSE fetch_id = $4::uuid END)
        ORDER BY created_at DESC LIMIT 1`, [project, input.kind, OPEN, fetchId, url.href, method])).rows[0];
      if (same) return {feedback: publicView(same), created: false};
      const now = new Date();
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const today = (await client.query('SELECT count(*)::int AS n FROM fetch_feedback WHERE project = $1 AND created_at >= $2',
        [project, day])).rows[0].n;
      if (today >= FEEDBACK_PER_DAY) {
        throw Object.assign(new GatewayError('too_many_requests', 429), {details: {limit: FEEDBACK_PER_DAY, period: 'day',
          retry_after_seconds: Math.max(1, Math.ceil((day.getTime() + DAY_MS - now.getTime()) / 1000))}});
      }
      const row = (await client.query(`INSERT INTO fetch_feedback (id, project, key_id, kind, fetch_id, url, method, host, message, evidence, fetch_record)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [randomUUID(), project, keyId, input.kind, fetchId, url.href, method, url.hostname.toLowerCase(), message, JSON.stringify(evidence),
        snapshot ? JSON.stringify(snapshot) : null])).rows[0];
      return {feedback: publicView(row), created: true};
    });
  }

  // GET /v1/feedback/{id}: one of the project's reports.
  async get(project, id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new GatewayError('not_found', 404);
    const row = (await this.store.pool.query('SELECT * FROM fetch_feedback WHERE id = $1 AND project = $2', [id, project])).rows[0];
    if (!row) throw new GatewayError('not_found', 404);
    return publicView(row);
  }

  // ---------- admin ----------

  // The newest reports, open ones first.
  async list({limit = 200} = {}) {
    return (await this.store.pool.query(`SELECT f.*, p.name AS project_name FROM fetch_feedback f
      LEFT JOIN control_projects p ON p.id = f.project
      ORDER BY (f.status = ANY($2)) DESC, f.created_at DESC LIMIT $1`, [limit, OPEN])).rows.map(adminView);
  }

  // Staff set a report's status and the reply the caller sees.
  async review(id, input, actor) {
    if (typeof id !== 'string' || !UUID.test(id)) fail('feedback_not_found', 404);
    if (!input || typeof input !== 'object' || (input.status === undefined && input.reply === undefined)) fail('feedback_review_required', 400);
    if (input.status !== undefined && !FEEDBACK_STATUSES.includes(input.status)) fail('feedback_status_invalid', 400);
    if (input.reply !== undefined && input.reply !== null && (typeof input.reply !== 'string' || input.reply.length > LIMITS.reply)) {
      fail('feedback_reply_invalid', 400);
    }
    const reply = input.reply === undefined ? undefined : input.reply === null ? null : input.reply.trim() || null;
    const row = (await this.store.pool.query(`UPDATE fetch_feedback SET status = coalesce($2, status),
        reply = CASE WHEN $3 THEN $4 ELSE reply END, reviewed_by = $5, updated_at = now()
      WHERE id = $1 RETURNING *, (SELECT name FROM control_projects WHERE id = fetch_feedback.project) AS project_name`,
    [id, input.status ?? null, reply !== undefined, reply ?? null, actor])).rows[0];
    if (!row) fail('feedback_not_found', 404);
    return adminView(row);
  }

  async prune() {
    await this.store.pool.query('DELETE FROM fetch_feedback WHERE created_at < now() - make_interval(days => $1)', [this.metadataDays]);
  }
}
