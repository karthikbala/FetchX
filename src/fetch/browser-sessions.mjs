// The platform side of browser sessions (POST /v1/browser-sessions): what a
// session may cost, the hold on the project's credits while it runs, charging
// it once when it ends, and carrying its caller's WebSocket to the engine,
// which runs the browser (karthikbala/fetchx-engine, contract 1.17).
//
// A session bills as one row of fetch_settlements (kind browser_session), so it
// counts toward the project's running requests and the key's credit limits like
// any request. create holds the flat price (on a residential route, plus the
// traffic max_credits allows, which becomes the engine's max_wire_bytes);
// settle charges it once, from the engine's receipt, when the receipt says
// billable (the session opened and did not end in error), and releases it
// otherwise. A session is settled when its caller closes or reads it after it
// ended, or by reconcile(). The receipt is kept with the row
// (browser_session_records), so it outlives the engine's 7 days.
import net from 'node:net';
import {STATUS_CODES} from 'node:http';
import {randomUUID} from 'node:crypto';
import {GatewayError, ID, fail} from '../policy.mjs';
import {sha} from '../crypto.mjs';
import {keyLimitError, keyLimitState} from './key-limits.mjs';
import {priceOf, priceParts} from '../billing/ledger.mjs';
import {budget} from '../budgets.mjs';

export const SESSION_LIMITS = Object.freeze({
  // Sessions a project may have open at once (config.browserSessions.maxPerProject).
  maxPerProject: 2,
  // The most traffic a session may move (the engine's own cap).
  maxWireBytes: 500_000_000,
  // Residential traffic held for a session sent without max_credits, past what its price includes.
  defaultTrafficMb: 100,
  // How long after a create the engine has answered (a browser takes up to a minute to start).
  launchMs: 120_000,
  // How long after its TTL a session that is still open is closed by reconcile().
  closeGraceMs: 60_000,
});
const MB = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ['allow_hosts', 'ttl_s', 'idle_ttl_s', 'route', 'secrets', 'login', 'viewport', 'max_credits', 'idempotency_key'];
// Headers of the caller's upgrade the engine gets; nothing else (its API key above all) goes on.
const UPGRADE_HEADERS = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions',
  'sec-websocket-protocol', 'user-agent'];
// The engine's create refusals that mean "no browser now", answered as unavailable.
const NO_BROWSER = new Set(['browser_unavailable', 'browser_capacity', 'route_unavailable', 'provider_excluded', 'residential_budget_exhausted',
  'residential_country_unavailable', 'residential_provider_unavailable']);

const invalid = (field, reason) => Object.assign(new GatewayError('invalid_request', 400), {details: {field, ...(reason ? {reason} : {})}});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const notFound = () => new GatewayError('browser_session_not_found', 404);
const tooMany = details => Object.assign(new GatewayError('too_many_requests', 429), {details});
const sort = value => Array.isArray(value) ? value.map(sort)
  : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;

// What an idempotency_key is compared with: the body without the key, and
// without secret values (nothing of them is kept, not even a hash).
function inputHash(raw) {
  const {idempotency_key: _key, ...rest} = raw;
  if (plain(rest.secrets)) {
    rest.secrets = Object.fromEntries(Object.entries(rest.secrets).map(([name, entry]) =>
      [name, plain(entry) ? {...entry, value: undefined} : entry]));
  }
  return sha(JSON.stringify(sort(JSON.parse(JSON.stringify(rest)))));
}

export async function initBrowserSessions(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS browser_session_records (
      id uuid PRIMARY KEY REFERENCES fetch_settlements (request) ON DELETE CASCADE,
      project text NOT NULL,
      step text NOT NULL CHECK (step IN ('browser_session', 'browser_session_residential')),
      -- The engine's receipt (its BrowserSession view, closed), once settled.
      receipt jsonb,
      -- The create's idempotency_key, and the body it is compared with (inputHash).
      idempotency_key text,
      input_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS browser_session_records_project ON browser_session_records (project, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS browser_session_records_key ON browser_session_records (project, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
}

// The engine's view of a session that never reached it (an uncertain create):
// closed, in error, nothing used.
function lostReceipt(id, created) {
  return {id, state: 'closed', created_at: created, ready_at: null, expires_at: null, closed_at: new Date().toISOString(), close_reason: 'error',
    ttl_s: null, idle_ttl_s: null, allow_hosts: [], route: null, login: null, secrets: [], browser: null, playwright: null,
    usage: {duration_s: 0, wire_bytes: 0, requests: 0, connections: 0}, blocked_requests: [], websockets: {opened: 0, refused: 0},
    secrets_used: [], secret_egress: [], refused_calls: {}, billable: false, error: 'browser_session_not_started'};
}

export class BrowserSessionFront {
  // front: the FetchFront (its concurrency limit); engine: the EngineClient.
  constructor({store, config, ledger, engine, front}) {
    Object.assign(this, {store, config, ledger, engine, front});
    this.limits = {...SESSION_LIMITS, ...config.browserSessions};
  }

  #limitFor(project) {
    return this.config.projects?.[project]?.maxBrowserSessions ?? this.limits.maxPerProject;
  }

  // wss://<api host>/v1/browser-sessions/{id}/ws
  #wsUrl(id) {
    const base = new URL(this.limits.wsBaseUrl ?? this.config.controlPlane?.apiBaseUrl ?? 'https://app.fetchx.ai');
    return `${base.protocol === 'http:' ? 'ws:' : 'wss:'}//${base.host}/v1/browser-sessions/${id}/ws`;
  }

  // What the platform checks of a create: its own field (max_credits), the
  // route it prices, and that nothing unknown is sent. The engine checks the rest.
  #input(raw) {
    if (!plain(raw)) throw invalid('body');
    for (const key of Object.keys(raw)) if (!FIELDS.includes(key)) throw invalid(key, 'unknown field');
    const route = raw.route ?? {class: 'datacenter'};
    if (!plain(route) || !['datacenter', 'residential'].includes(route.class) || Object.keys(route).some(key => !['class', 'country'].includes(key))) {
      throw invalid('route', '{class: datacenter or residential, country?}');
    }
    if (route.country !== undefined && (typeof route.country !== 'string' || !/^[A-Z]{2}$/.test(route.country))) {
      throw invalid('route.country', 'an ISO 3166-1 alpha-2 code, such as US');
    }
    const key = raw.idempotency_key ?? null;
    if (key !== null && (typeof key !== 'string' || !ID.test(key))) throw invalid('idempotency_key', '1 to 160 characters from A-Z a-z 0-9 _ . : -');
    const maxCredits = raw.max_credits ?? null;
    if (maxCredits !== null && (!Number.isSafeInteger(maxCredits) || maxCredits < 1 || maxCredits > 100_000)) throw invalid('max_credits', '1 to 100000');
    const residential = route.class === 'residential';
    const {route: _route, max_credits: _max, idempotency_key: _key, ...rest} = raw;
    return {engine: {...rest, proxy: route.class, country: route.country ?? 'US'}, maxCredits, residential, key, hash: inputHash(raw),
      step: residential ? 'browser_session_residential' : 'browser_session'};
  }

  // ---------- admission ----------

  // -> {session, created}: created false when the idempotency_key already has a session.
  async create(project, raw, {keyId = null} = {}) {
    const input = this.#input(raw);
    const id = randomUUID();
    const price = this.ledger.prices[input.step];
    const ttl = Number.isSafeInteger(raw.ttl_s) ? raw.ttl_s : 300;
    const existing = await this.store.tx(async client => {
      await this.ledger.lock(client, project);
      // Creates are serialised per project here, so a key is checked once.
      if (input.key !== null) {
        const row = (await client.query(`SELECT r.id, r.input_hash, s.status, s.error_code, s.credits_max FROM browser_session_records r
          JOIN fetch_settlements s ON s.request = r.id WHERE r.project = $1 AND r.idempotency_key = $2`, [project, input.key])).rows[0];
        if (row) return row;
      }
      const counts = (await client.query(`SELECT count(*)::int AS running, count(*) FILTER (WHERE kind = 'browser_session')::int AS sessions
        FROM fetch_settlements WHERE project = $1 AND status = 'pending'`, [project])).rows[0];
      const cap = this.front.concurrencyLimit(project);
      if (counts.running >= cap) throw tooMany({limit: 'requests', max: cap, running: counts.running, retry_after_seconds: 5});
      const sessionCap = this.#limitFor(project);
      if (counts.sessions >= sessionCap) {
        throw tooMany({limit: 'browser_sessions', max: sessionCap, running: counts.sessions, retry_after_seconds: 30});
      }
      // The most this session may cost: its price, and on a residential route
      // the traffic max_credits allows (or the default allowance).
      if (Math.min(input.maxCredits ?? Infinity, budget(this.config, 'fetch.maxCreditsPerRequest')) < price) {
        throw Object.assign(new GatewayError('max_credits_too_low', 402), {details: {min_credits: price}});
      }
      const ceiling = this.#ceiling(input);
      let held = null;
      if (this.ledger.metered(project)) {
        const balance = await this.ledger.balance(project, client);
        if (balance.held) fail('payment_hold', 402);
        const key = await keyLimitState(client, keyId);
        if (key.room < price) throw keyLimitError(key, price);
        if (balance.available < price) throw Object.assign(new GatewayError('insufficient_credits', 402), {details: {available: balance.available, needed: price}});
        held = Math.min(ceiling, balance.available, key.room);
        await this.ledger.hold(client, {project, request: id, credits: held});
      }
      await client.query(`INSERT INTO fetch_settlements (request, project, key_id, kind, credits_max, deadline)
        VALUES ($1, $2, $3, 'browser_session', $4, clock_timestamp() + make_interval(secs => $5))`,
      [id, project, keyId, held, (this.limits.launchMs + ttl * 1000 + this.limits.closeGraceMs) / 1000]);
      await client.query('INSERT INTO browser_session_records (id, project, step, idempotency_key, input_hash) VALUES ($1, $2, $3, $4, $5)',
        [id, project, input.step, input.key, input.hash]);
      this.#wire(input, held ?? ceiling);
      return null;
    });
    if (existing) {
      if (existing.input_hash !== input.hash) throw new GatewayError('idempotency_conflict', 409);
      // Its first answer was lost: send it again (the engine answers with the
      // session when it has it, and starts it when it does not).
      if (existing.status === 'pending' && existing.error_code === 'create_uncertain') {
        this.#wire(input, existing.credits_max === null ? this.#ceiling(input) : Number(existing.credits_max));
        await this.#send(project, existing.id, input, {fresh: false});
        return {session: await this.get(project, existing.id), created: false};
      }
      return {session: await this.get(project, existing.id), created: false};
    }
    const session = await this.#send(project, id, input, {fresh: true});
    return {session: this.#view(session, await this.#record(project, id)), created: true};
  }

  // The most a session may hold: its price, and on a residential route the
  // traffic max_credits allows (or the default allowance), within the budget.
  #ceiling(input) {
    const table = this.ledger.prices;
    const price = table[input.step];
    if (!input.residential) return price;
    return Math.min(input.maxCredits ?? price + this.limits.defaultTrafficMb * table.residential_overage_per_mb,
      budget(this.config, 'fetch.maxCreditsPerRequest'));
  }

  // A residential session's traffic limit: what `credits` pays for past its
  // price (the engine closes it there: traffic_limit).
  #wire(input, credits) {
    if (!input.residential) return;
    const table = this.ledger.prices;
    const included = table.residential_included_mb[input.step] ?? 0;
    const mb = included + Math.floor((credits - table[input.step]) / table.residential_overage_per_mb);
    input.engine.max_wire_bytes = Math.min(this.limits.maxWireBytes, Math.max(1, mb) * MB);
  }

  // Sends a create to the engine with the platform's id, and answers with the
  // engine's view. A fresh create the engine refused or never got is dropped
  // with its hold. One whose answer was lost is kept as create_uncertain:
  // never charged unless its caller gets it after all (a resend with the same
  // idempotency_key, or a client connecting); without a key it is closed now.
  // A resend refused for anything but its fields means the engine does not
  // have it (a known id is answered before any limit), so it is dropped too.
  async #send(project, id, input, {fresh}) {
    let session;
    try {
      session = await this.engine.createBrowserSession(project, {id, ...input.engine});
    } catch (error) {
      if (error.fromEngine && (fresh || error.status !== 400)) await this.#discard(id);
      else if (fresh && error.sent === false) await this.#discard(id);
      else await this.#abandon(project, id, {close: input.key === null});
      if (error.code === 'browser_session_limit') {
        throw tooMany({limit: 'browser_sessions', max: error.details?.limit ?? this.#limitFor(project), running: error.details?.open ?? null,
          retry_after_seconds: 30});
      }
      if (error.fromEngine && (NO_BROWSER.has(error.code) || error.status >= 500)) {
        throw Object.assign(new GatewayError('unavailable', 503), {details: {reason: error.code, retry_after_seconds: 30}});
      }
      throw error;
    }
    if (!fresh && session.state !== 'closed') await this.#delivered(id);
    if (session.expires_at) {
      await this.store.pool.query(`UPDATE fetch_settlements SET deadline = $2::timestamptz + make_interval(secs => $3)
        WHERE request = $1 AND status = 'pending'`, [id, session.expires_at, this.limits.closeGraceMs / 1000]);
    }
    return session;
  }

  // A session the engine refused or never got: nothing is held or kept.
  async #discard(id) {
    await this.store.tx(async client => {
      await this.ledger.release(client, {request: id});
      await client.query(`DELETE FROM fetch_settlements WHERE request = $1 AND status = 'pending'`, [id]);
    });
  }

  // A create whose answer was lost: the engine may have started it, so it is
  // kept to be settled by reconcile() from what the engine says, free unless
  // #delivered. Without an idempotency_key nobody can ask for it again, so it is
  // closed now; with one it waits for the resend (or ends idle).
  async #abandon(project, id, {close}) {
    await this.store.pool.query(`UPDATE fetch_settlements SET error_code = 'create_uncertain' WHERE request = $1 AND status = 'pending'`, [id]);
    if (close) this.engine.closeBrowserSession(project, id).catch(() => {});
  }

  // The caller has an uncertain session after all: it bills like any other.
  async #delivered(id) {
    await this.store.pool.query(`UPDATE fetch_settlements SET error_code = NULL
      WHERE request = $1 AND status = 'pending' AND error_code = 'create_uncertain'`, [id]);
  }

  // ---------- settlement ----------

  // Settles a session once, from its engine receipt (state closed): charges
  // its price (plus residential traffic past what it includes, never more than
  // was held) when the receipt says billable, else releases the hold. Keeps
  // the receipt. Returns nothing; read the record again for the result.
  async #settle(project, id, receipt) {
    if (receipt?.state !== 'closed') return;
    await this.store.tx(async client => {
      const current = (await client.query(`SELECT s.*, r.step AS session_step FROM fetch_settlements s JOIN browser_session_records r ON r.id = s.request
        WHERE s.request = $1 AND s.kind = 'browser_session' FOR UPDATE OF s`, [id])).rows[0];
      if (!current || current.project !== project) return;
      if (current.status === 'pending') {
        const wireBytes = Number.isSafeInteger(receipt.usage?.wire_bytes) && receipt.usage.wire_bytes >= 0 ? receipt.usage.wire_bytes : 0;
        const billable = receipt.billable === true && current.error_code !== 'create_uncertain';
        let charged = 0;
        if (billable && this.ledger.metered(project) && current.credits_max !== null) {
          const price = priceOf(this.ledger.prices, {step: current.session_step, wireBytes});
          charged = await this.ledger.charge(client, {project, request: id, step: current.session_step,
            credits: Math.min(price, Number(current.credits_max))});
        } else {
          await this.ledger.release(client, {request: id});
        }
        await client.query(`UPDATE fetch_settlements SET status = $2, error_code = $3, step = $4, credits_charged = $5, wire_bytes = $6,
          settled_at = clock_timestamp() WHERE request = $1`, [id, billable ? 'succeeded' : 'failed',
          billable ? null : current.error_code ?? receipt.error ?? receipt.close_reason ?? 'error', billable ? current.session_step : null, charged, wireBytes]);
      }
      await client.query('UPDATE browser_session_records SET receipt = $2 WHERE id = $1 AND receipt IS NULL', [id, receipt]);
    });
  }

  // A session the engine does not know (its create never reached it, or its
  // receipt is gone): settled as lost, not charged.
  async #lost(project, record) {
    await this.#settle(project, record.id, lostReceipt(record.id, new Date(record.created_at).toISOString()));
  }

  // Sessions not settled yet: each is read from the engine, settled when it
  // has ended, and closed when it outlived its deadline. Runs beside the
  // fetch reconciler.
  async reconcile({limit = 100} = {}) {
    const rows = (await this.store.pool.query(`SELECT request, project, deadline < clock_timestamp() AS overdue FROM fetch_settlements
      WHERE kind = 'browser_session' AND status = 'pending' AND created_at < clock_timestamp() - interval '30 seconds'
      ORDER BY created_at LIMIT $1`, [limit])).rows;
    let settled = 0;
    for (const row of rows) {
      try {
        let receipt = await this.#engineView(row.project, row.request);
        if (receipt && receipt.state !== 'closed' && row.overdue) receipt = await this.engine.closeBrowserSession(row.project, row.request);
        if (receipt?.state === 'closed') {
          await this.#settle(row.project, row.request, receipt);
          settled++;
        } else if (receipt === null) {
          await this.#lost(row.project, await this.#record(row.project, row.request));
          settled++;
        }
      } catch {
        // The engine is down: try again next pass.
      }
    }
    return settled;
  }

  // ---------- reading ----------

  async #record(project, id) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    return (await this.store.pool.query(`SELECT r.*, s.status, s.credits_max, s.credits_charged, s.error_code
      FROM browser_session_records r JOIN fetch_settlements s ON s.request = r.id WHERE r.id = $1 AND r.project = $2`, [id, project])).rows[0] ?? null;
  }

  // The engine's view of a session, or null when it does not know it.
  async #engineView(project, id) {
    try {
      return await this.engine.getBrowserSession(project, id);
    } catch (error) {
      if (error.code === 'not_found') return null;
      throw error;
    }
  }

  // The session as it stands, settled first if it has ended.
  async #current(project, record) {
    if (record.receipt) return record;
    const view = await this.#engineView(project, record.id);
    if (view === null) await this.#lost(project, record);
    else if (view.state === 'closed') await this.#settle(project, record.id, view);
    else return {...record, live: view};
    return this.#record(project, record.id);
  }

  async get(project, id) {
    const record = await this.#record(project, id);
    if (!record) throw notFound();
    const current = await this.#current(project, record);
    return this.#view(current.live ?? current.receipt, current);
  }

  async list(project, query = {}) {
    for (const key of Object.keys(query)) if (key !== 'status') throw invalid(key, 'unknown parameter');
    if (query.status !== undefined && !['open', 'closed'].includes(query.status)) throw invalid('status', 'open or closed');
    const rows = (await this.store.pool.query(`SELECT r.*, s.status, s.credits_max, s.credits_charged, s.error_code
      FROM browser_session_records r JOIN fetch_settlements s ON s.request = r.id WHERE r.project = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [project])).rows;
    const open = rows.filter(row => !row.receipt);
    const live = open.length ? new Map((await this.engine.listBrowserSessions(project, 'open')).map(view => [view.id, view])) : new Map();
    const items = [];
    for (const row of rows) {
      const current = row.receipt ? row : live.has(row.id) ? {...row, live: live.get(row.id)} : await this.#current(project, row);
      const view = this.#view(current.live ?? current.receipt, current);
      if (!query.status || (query.status === 'closed') === (view.status === 'closed')) items.push(view);
    }
    return {items};
  }

  // Closes a session (DELETE) and answers with its receipt.
  async close(project, id) {
    const record = await this.#record(project, id);
    if (!record) throw notFound();
    if (record.receipt) return this.#view(record.receipt, record);
    let view;
    try {
      view = await this.engine.closeBrowserSession(project, id);
    } catch (error) {
      if (error.code !== 'not_found') throw error;
      view = null;
    }
    if (view === null) await this.#lost(project, record);
    else if (view.state === 'closed') await this.#settle(project, id, view);
    else return this.#view(view, record);
    const settled = await this.#record(project, id);
    return this.#view(settled.receipt, settled);
  }

  // Types one of the session's secrets into a field (the value stays with FetchX).
  async fill(project, id, body) {
    const record = await this.#record(project, id);
    if (!record) throw notFound();
    if (record.receipt) throw new GatewayError('browser_session_closed', 410);
    try {
      return await this.engine.fillBrowserSession(project, id, body ?? {});
    } catch (error) {
      if (error.code === 'not_found') throw notFound();
      if (error.code === 'browser_session_closed') void this.#current(project, record).catch(() => {});
      throw error;
    }
  }

  // Sessions the project may have open at once, and how many are, for GET /v1/me.
  async concurrency(project) {
    const running = (await this.store.pool.query(`SELECT count(*)::int AS n FROM fetch_settlements
      WHERE project = $1 AND kind = 'browser_session' AND status = 'pending'`, [project])).rows[0].n;
    return {limit: this.#limitFor(project), running};
  }

  // The public view (docs/openapi.json BrowserSession) of the engine's view of
  // a session, with what it was held and charged.
  #view(session, record) {
    const usage = session.usage ?? {};
    const closed = session.state === 'closed';
    const wireBytes = Number.isSafeInteger(usage.wire_bytes) ? usage.wire_bytes : 0;
    const charged = Number(record.credits_charged ?? 0);
    const parts = closed && charged > 0 ? priceParts(this.ledger.prices, {step: record.step, wireBytes}) : null;
    return {
      id: record.id,
      idempotency_key: record.idempotency_key ?? null,
      status: session.state,
      created_at: new Date(record.created_at).toISOString(),
      ready_at: session.ready_at ?? null,
      expires_at: session.expires_at ?? null,
      closed_at: session.closed_at ?? null,
      close_reason: session.close_reason ?? null,
      ws_url: this.#wsUrl(record.id),
      playwright: session.playwright ?? null,
      browser: session.browser ?? null,
      ttl_s: session.ttl_s ?? null,
      idle_ttl_s: session.idle_ttl_s ?? null,
      allow_hosts: session.allow_hosts ?? [],
      route: session.route ? {class: session.route.class, country: session.route.country} : null,
      login: session.login ?? null,
      secrets: session.secrets ?? [],
      duration_s: Number.isFinite(usage.duration_s) ? usage.duration_s : 0,
      traffic_mb: Math.round(wireBytes / (MB / 10)) / 10,
      requests: Number.isSafeInteger(usage.requests) ? usage.requests : 0,
      connections: closed && Number.isSafeInteger(usage.connections) ? usage.connections : null,
      blocked_requests: (session.blocked_requests ?? []).map(({origin, type}) => ({origin, type, action_index: null})),
      websockets: session.websockets ?? {opened: 0, refused: 0},
      secrets_used: session.secrets_used ?? [],
      secret_egress: session.secret_egress ?? [],
      refused_calls: session.refused_calls ?? {},
      credits: {max: record.credits_max === null || record.credits_max === undefined ? null : Number(record.credits_max), charged,
        breakdown: parts ? {step: parts.step, step_credits: parts.step_credits, traffic_mb: parts.traffic_mb, included_mb: parts.included_mb,
          traffic_credits: parts.traffic_credits} : null},
      error: closed && session.close_reason === 'error' ? session.error ?? 'browser_failed' : null,
    };
  }

  // ---------- the caller's WebSocket ----------

  // Carries an authenticated caller's upgrade (server.mjs checked its key) to
  // the engine, with the service token in place of the caller's key, and then
  // the connection both ways. `refuse(status, code)` answers it otherwise.
  async upgrade(project, id, req, socket, head, refuse) {
    const record = await this.#record(project, id);
    if (!record) return refuse(404, 'browser_session_not_found');
    if (record.receipt || record.status !== 'pending') return refuse(410, 'browser_session_closed');
    const target = this.engine.sessionUpgradeTarget(project, id);
    if (!target) return refuse(503, 'unavailable');
    // A client that connects has the session, whatever happened to its create's answer.
    if (record.error_code === 'create_uncertain') await this.#delivered(id);
    const lines = [`GET ${target.path} HTTP/1.1`, `Host: ${target.host}:${target.port}`, `Authorization: ${target.authorization}`];
    for (const name of UPGRADE_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string' && !/[\r\n]/.test(value)) lines.push(`${name}: ${value}`);
    }
    const upstream = (this.connect ?? net.connect)({host: target.host, port: target.port});
    upstream.setTimeout(10_000, () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  }
}

// An HTTP answer to an upgrade that is refused, in the API's error shape.
export function refuseUpgrade(socket, status, body) {
  const text = JSON.stringify(body);
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json\r\n`
    + `Cache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
}
