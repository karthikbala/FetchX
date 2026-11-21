// Service status: notices that operators post from the admin portal
// (incidents, and planned maintenance that may pause the API), and the public
// status GET /v1/status shows. The status page on fetchx.ai does not depend on
// this process: a Cloudflare Worker reads GET /v1/status every minute and
// keeps the history, so the page still says "down" when nothing here answers.
//
// Maintenance: while a maintenance notice with pause_api is active, every
// /v1 route except GET /v1/status answers 503 `maintenance` with
// Retry-After and the status page's link, so clients can pause on their own.
import {GatewayError, fail} from './policy.mjs';
import {API_VERSION} from './api/version.mjs';

export const COMPONENTS = Object.freeze([
  {id: 'api', name: 'API'},
  {id: 'fetching', name: 'Fetching'},
  {id: 'console', name: 'Console and billing'},
]);
const COMPONENT_IDS = COMPONENTS.map(component => component.id);
export const IMPACTS = Object.freeze(['none', 'minor', 'major']);
// Worst first; a component takes the worst state any notice gives it.
const RANK = ['major_outage', 'maintenance', 'partial_outage', 'degraded', 'operational'];
const DEFAULT_LINKS = Object.freeze({status_page: 'https://fetchx.ai/status', changelog: 'https://fetchx.ai/changelog',
  docs: 'https://fetchx.ai/docs'});
const REFRESH_MS = 5_000;
const ENGINE_CACHE_MS = 15_000;
const VIEW_CACHE_MS = 10_000;
const RECENT_DAYS = 14;
const MAX_TEXT = 4000;

export async function initStatus(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS status_notices (
      id bigserial PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('incident', 'maintenance')),
      title text NOT NULL,
      body text NOT NULL DEFAULT '',
      impact text NOT NULL DEFAULT 'minor' CHECK (impact IN ('none', 'minor', 'major')),
      components text[] NOT NULL DEFAULT '{}',
      pause_api boolean NOT NULL DEFAULT false,
      starts_at timestamptz NOT NULL DEFAULT now(),
      ends_at timestamptz,
      resolved_at timestamptz,
      -- [{at, text}], oldest first: what was said as it went
      updates jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by text NOT NULL,
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (kind = 'maintenance' OR NOT pause_api)
    );
    CREATE INDEX IF NOT EXISTS status_notices_open ON status_notices (starts_at) WHERE resolved_at IS NULL;
  `);
}

export const linksOf = config => ({...DEFAULT_LINKS, ...config?.status?.links});

// The phase a notice is in at `now`.
const phaseOf = (notice, now) => notice.resolved_at ? 'resolved' : +new Date(notice.starts_at) > now ? 'scheduled' : 'active';
const iso = value => value ? new Date(value).toISOString() : null;
const publicNotice = (notice, now) => ({id: String(notice.id), kind: notice.kind, title: notice.title, body: notice.body,
  impact: notice.kind === 'maintenance' ? 'maintenance' : notice.impact, components: notice.components, pause_api: notice.pause_api,
  status: phaseOf(notice, now), starts_at: iso(notice.starts_at), ends_at: iso(notice.ends_at), resolved_at: iso(notice.resolved_at),
  updates: notice.updates ?? []});
// What operators see: the public notice and who wrote and last changed it.
const adminNotice = (notice, now) => ({...publicNotice(notice, now), created_by: notice.created_by, updated_by: notice.updated_by ?? null,
  created_at: iso(notice.created_at), updated_at: iso(notice.updated_at)});
const componentState = notice => notice.kind === 'maintenance' ? (notice.pause_api ? 'maintenance' : 'operational')
  : notice.impact === 'major' ? 'major_outage' : notice.impact === 'minor' ? 'degraded' : 'operational';
const worst = states => states.reduce((a, b) => RANK.indexOf(a) <= RANK.indexOf(b) ? a : b, 'operational');

function checkText(value, field, {max = MAX_TEXT, required = false} = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) fail(`${field}_invalid`, 400);
  return value.trim();
}
function checkTime(value, field) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const time = new Date(typeof value === 'string' ? value : NaN);
  if (Number.isNaN(time.getTime())) fail(`${field}_invalid`, 400);
  return time;
}

export class StatusBoard {
  // engine: the EngineClient, for whether fetching answers.
  constructor({store, config, engine}) {
    Object.assign(this, {store, config, engine});
    this.open = [];
    this.loadedAt = 0;
    this.engineState = null;
    this.view = null;
  }

  // Open notices (scheduled or active), at most every REFRESH_MS. A database
  // that does not answer keeps the last known list.
  async refresh({force = false} = {}) {
    if (!force && Date.now() - this.loadedAt < REFRESH_MS) return this.open;
    try {
      this.open = (await this.store.pool.query('SELECT * FROM status_notices WHERE resolved_at IS NULL ORDER BY starts_at')).rows;
      this.loadedAt = Date.now();
    } catch {
      process.stderr.write('status_refresh_failed\n');
    }
    return this.open;
  }

  // The active maintenance notice that pauses the API, or null.
  async paused(now = Date.now()) {
    const open = await this.refresh();
    return open.find(notice => notice.pause_api && phaseOf(notice, now) === 'active') ?? null;
  }

  // The 503 a paused API answers with.
  maintenanceError(notice, now = Date.now()) {
    const until = notice.ends_at ? Math.ceil((+new Date(notice.ends_at) - now) / 1000) : null;
    return Object.assign(new GatewayError('maintenance', 503), {details: {
      title: notice.title, ends_at: iso(notice.ends_at), status_url: linksOf(this.config).status_page,
      retry_after_seconds: Math.min(3600, Math.max(30, until ?? 300))}});
  }

  async #fetching() {
    if (this.engineState && Date.now() - this.engineState.at < ENGINE_CACHE_MS) return this.engineState.value;
    let value;
    try {
      await this.engine.status();
      value = 'operational';
    } catch {
      value = 'major_outage';
    }
    this.engineState = {at: Date.now(), value};
    return value;
  }

  // GET /v1/status: cached for ten seconds, since anyone may call it.
  async publicView(now = Date.now()) {
    if (this.view && now - this.view.at < VIEW_CACHE_MS) return this.view.value;
    await this.refresh();
    let recent = [];
    try {
      recent = (await this.store.pool.query(`SELECT * FROM status_notices WHERE resolved_at > now() - make_interval(days => $1)
        ORDER BY resolved_at DESC LIMIT 20`, [RECENT_DAYS])).rows;
    } catch { /* the open list still answers */ }
    const active = this.open.filter(notice => phaseOf(notice, now) === 'active');
    const fetching = await this.#fetching();
    const components = COMPONENTS.map(component => ({...component, status: worst([
      ...(component.id === 'fetching' ? [fetching] : []),
      ...active.filter(notice => notice.components.includes(component.id)
        || (notice.pause_api && ['api', 'fetching'].includes(component.id))).map(componentState),
    ])}));
    const overall = worst(components.map(component => component.status));
    const value = {
      status: overall === 'operational' ? 'operational' : overall,
      updated_at: new Date(now).toISOString(),
      components,
      notices: [...this.open, ...recent].map(notice => publicNotice(notice, now)),
      api: {version: API_VERSION},
      links: linksOf(this.config),
    };
    this.view = {at: now, value};
    return value;
  }

  // ---------- admin ----------

  async list() {
    return (await this.store.pool.query(`SELECT * FROM status_notices WHERE resolved_at IS NULL
      OR resolved_at > now() - make_interval(days => 90) ORDER BY coalesce(resolved_at, 'infinity'::timestamptz) DESC, starts_at DESC LIMIT 100`))
      .rows.map(notice => adminNotice(notice, Date.now()));
  }

  #fields(input, {creating}) {
    const kind = creating ? input.kind : undefined;
    if (creating && !['incident', 'maintenance'].includes(kind)) fail('notice_kind_invalid', 400);
    const out = {
      title: checkText(input.title, 'notice_title', {max: 200, required: creating}),
      body: checkText(input.body, 'notice_body'),
      impact: input.impact,
      components: input.components,
      pause_api: input.pause_api,
      starts_at: checkTime(input.starts_at, 'notice_starts_at'),
      ends_at: checkTime(input.ends_at, 'notice_ends_at'),
    };
    if (out.impact !== undefined && !IMPACTS.includes(out.impact)) fail('notice_impact_invalid', 400);
    if (out.components !== undefined && (!Array.isArray(out.components) || out.components.some(id => !COMPONENT_IDS.includes(id))
      || new Set(out.components).size !== out.components.length)) fail('notice_components_invalid', 400);
    if (out.pause_api !== undefined && typeof out.pause_api !== 'boolean') fail('notice_pause_api_invalid', 400);
    if (out.starts_at === null) fail('notice_starts_at_invalid', 400);
    return {kind, ...Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined))};
  }

  async create(input, actor) {
    const fields = this.#fields(input ?? {}, {creating: true});
    if (fields.pause_api && fields.kind !== 'maintenance') fail('notice_pause_api_invalid', 400);
    const update = checkText(input.update, 'notice_update');
    const row = (await this.store.pool.query(`INSERT INTO status_notices (kind, title, body, impact, components, pause_api, starts_at, ends_at,
      updates, created_by) VALUES ($1, $2, coalesce($3, ''), coalesce($4, 'minor'), coalesce($5, '{}'::text[]), coalesce($6, false),
      coalesce($7, now()), $8, $9, $10) RETURNING *`,
    [fields.kind, fields.title, fields.body ?? null, fields.impact ?? null, fields.components ?? null, fields.pause_api ?? null,
      fields.starts_at ?? null, fields.ends_at ?? null, JSON.stringify(update ? [{at: new Date().toISOString(), text: update}] : []), actor]))
      .rows[0];
    await this.#changed();
    return adminNotice(row, Date.now());
  }

  // Changes the given fields; `update` adds a line to the notice's history.
  async change(id, input, actor) {
    const fields = this.#fields(input ?? {}, {creating: false});
    const update = checkText(input?.update, 'notice_update');
    const row = await this.store.tx(async client => {
      const current = (await client.query('SELECT * FROM status_notices WHERE id = $1 FOR UPDATE', [this.#id(id)])).rows[0];
      if (!current) fail('notice_not_found', 404);
      if (current.resolved_at) fail('notice_resolved', 409);
      const next = {...current, ...fields};
      if (next.pause_api && current.kind !== 'maintenance') fail('notice_pause_api_invalid', 400);
      const updates = update ? [...current.updates, {at: new Date().toISOString(), text: update}] : current.updates;
      return (await client.query(`UPDATE status_notices SET title = $2, body = $3, impact = $4, components = $5, pause_api = $6,
        starts_at = $7, ends_at = $8, updates = $9, updated_by = $10, updated_at = now() WHERE id = $1 RETURNING *`,
      [current.id, next.title, next.body, next.impact, next.components, next.pause_api, next.starts_at, next.ends_at,
        JSON.stringify(updates), actor])).rows[0];
    });
    await this.#changed();
    return adminNotice(row, Date.now());
  }

  // Ends a notice (and the pause, if it held one).
  async resolve(id, input, actor) {
    const update = checkText(input?.update, 'notice_update');
    const row = (await this.store.pool.query(`UPDATE status_notices SET resolved_at = now(), pause_api = false, updated_by = $3,
      updated_at = now(), updates = updates || $2::jsonb WHERE id = $1 AND resolved_at IS NULL RETURNING *`,
    [this.#id(id), JSON.stringify([{at: new Date().toISOString(), text: update ?? 'Resolved.'}]), actor])).rows[0];
    if (!row) fail('notice_not_found', 404);
    await this.#changed();
    return adminNotice(row, Date.now());
  }

  #id(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,17}$/.test(value)) fail('notice_not_found', 404);
    return value;
  }

  async #changed() {
    this.view = null;
    await this.refresh({force: true});
  }
}
