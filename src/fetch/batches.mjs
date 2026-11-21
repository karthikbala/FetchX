// Batches: many URLs in one job (POST /v1/batches).
//
// A caller sends up to 1000 items and the settings they share. FetchX checks
// every item with the engine before anything is queued, then starts the items
// itself, per site, at the pace the engine says the site can take
// (POST /internal/v1/pace, from site knowledge shared across customers), so
// the caller needs no pacing or polling loop of its own. Each item is an
// ordinary fetch job: reserved when it starts, charged only if it succeeds,
// readable at GET /v1/fetch/{id}. Results go to the batch's webhook as each
// item finishes (fetch.finished) and when the batch ends (batch.finished);
// GET /v1/batches/{id}/items pages through them for callers who poll.
//
//   BatchService   submit, read, list, cancel; the hooks FetchFront calls
//                  inside its transactions (claim, settled, discarded).
//   BatchRunner    the queue: every tick, asks the engine how fast each host
//                  with queued items may take work, and starts what fits.
//
// Items never start while the engine has jobs waiting for a browser, never
// take a project's last running slot (kept for single requests), and a batch
// whose credits run out pauses until the balance covers its next item.
import {randomUUID} from 'node:crypto';
import {GatewayError, ID} from '../policy.mjs';
import {sha} from '../crypto.mjs';
import {budget} from '../budgets.mjs';
import {blockedHosts, checkUrl} from './destination.mjs';

export const BATCH_LIMITS = Object.freeze({
  maxItems: 1000,
  // Items a project may have waiting at once, across its batches.
  maxQueuedPerProject: 10_000,
  // One engine check call: at most this many requests and about this many bytes.
  checkCount: 1000,
  checkBytes: 2_000_000,
  // Hosts named in one pace call.
  paceHosts: 500,
  // Queued (host, batch) pairs one tick looks at.
  tickPairs: 5000,
  // An item marked running that never got a settlement row (the platform
  // stopped between the two) goes back to the queue after this.
  orphanMs: 600_000,
  // Engine reads at once when a page of items includes their results.
  resultReads: 8,
  metadataDays: 90,
});
const BATCH_FIELDS = ['items', 'defaults', 'webhook_url', 'idempotency_key', 'tags'];
// The batch owns these: every item runs async, reports to the batch's webhook
// and gets an idempotency key of its own (ITEM_KEY).
const BATCH_OWNED = ['async', 'webhook_url', 'idempotency_key'];
const TAG = /^[A-Za-z0-9_.:-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ITEM_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'];
const FEED_LAG_MS = 2000;
const FEED_START = '1970-01-01T00:00:00.000Z';
// Each item's job key: a restart after an uncertain start finds the same job
// in the engine instead of running the item twice.
export const ITEM_KEY_PREFIX = 'batch.';
const itemKey = (batch, index) => `${ITEM_KEY_PREFIX}${batch}.${index}`;
// Refusals that end an item before it starts (nothing sent, nothing charged).
const ITEM_REFUSALS = new Set(['invalid_request', 'url_not_allowed', 'request_too_large', 'max_credits_too_low', 'idempotency_conflict']);

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (field, reason) => Object.assign(new GatewayError('invalid_request', 400), {details: {field, ...(reason ? {reason} : {})}});
const sort = value => Array.isArray(value) ? value.map(sort)
  : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
const canonical = value => JSON.stringify(sort(value));
const iso = value => value ? new Date(value).toISOString() : null;

// The batch body, checked for shape and expanded into one POST /v1/fetch body
// per item: the item's own fields over `defaults` (a shallow merge; a string
// item is {url}). The engine checks each merged request before the batch is
// queued (BatchService.submit). Pure, so a cost estimate can expand a batch
// exactly as it will run.
export function expandBatch(raw, {blocked = new Set()} = {}) {
  if (!plain(raw)) throw invalid('body', 'must be a JSON object');
  for (const key of Object.keys(raw)) if (!BATCH_FIELDS.includes(key)) throw invalid(key, 'unknown field');
  const defaults = raw.defaults ?? {};
  if (!plain(defaults)) throw invalid('defaults', 'an object of POST /v1/fetch fields');
  for (const key of ['url', ...BATCH_OWNED]) {
    if (defaults[key] !== undefined) throw invalid(`defaults.${key}`, key === 'url' ? 'each item has its own url' : 'set on the batch, not per item');
  }
  const items = raw.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > BATCH_LIMITS.maxItems) {
    throw invalid('items', `1 to ${BATCH_LIMITS.maxItems} URLs or POST /v1/fetch bodies`);
  }
  const expanded = items.map((item, index) => {
    const own = typeof item === 'string' ? {url: item} : item;
    if (!plain(own) || typeof own.url !== 'string' || !own.url) throw invalid(`items[${index}]`, 'a URL, or an object with url');
    for (const key of BATCH_OWNED) if (own[key] !== undefined) throw invalid(`items[${index}].${key}`, 'set on the batch, not per item');
    return {index, own, request: {...defaults, ...own}};
  });
  let webhookUrl = null;
  if (raw.webhook_url !== undefined && raw.webhook_url !== null) {
    let hook;
    try { hook = checkUrl(raw.webhook_url, {blocked}); } catch { throw invalid('webhook_url', 'a public https URL'); }
    if (hook.protocol !== 'https:') throw invalid('webhook_url', 'a public https URL');
    webhookUrl = hook.href;
  }
  const key = raw.idempotency_key ?? null;
  if (key !== null && (typeof key !== 'string' || !ID.test(key))) throw invalid('idempotency_key', '1 to 160 characters from A-Z a-z 0-9 _ . : -');
  const tags = raw.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 10 || !tags.every(tag => typeof tag === 'string' && TAG.test(tag))) {
    throw invalid('tags', 'up to 10 tags of 1 to 64 characters from A-Z a-z 0-9 _ . : -');
  }
  return {items: expanded, defaults, webhookUrl, idempotencyKey: key, tags: [...tags].sort(),
    // Everything but the key decides "the same batch".
    hash: sha(canonical({items, defaults, webhook_url: webhookUrl, tags: [...tags].sort()}))};
}

export async function initBatches(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fetch_batches (
      id uuid PRIMARY KEY,
      project text NOT NULL,
      key_id text,
      idempotency_key text NOT NULL,
      input_hash text NOT NULL,
      -- Sealed: the settings the items share, and where results go.
      defaults bytea NOT NULL,
      webhook_url bytea,
      tags text[] NOT NULL DEFAULT '{}',
      total int NOT NULL,
      status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'finished', 'canceled')),
      paused_reason text,
      paused_needed bigint,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      finished_at timestamptz,
      canceled_at timestamptz,
      UNIQUE (project, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS fetch_batches_project_created ON fetch_batches (project, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS fetch_batches_paused ON fetch_batches (created_at) WHERE status = 'paused';
    CREATE TABLE IF NOT EXISTS fetch_batch_items (
      batch uuid NOT NULL REFERENCES fetch_batches (id) ON DELETE CASCADE,
      n int NOT NULL,
      -- The host the item is paced under (from the engine's check); the item
      -- itself (url and own fields) is sealed.
      host text NOT NULL,
      input bytea NOT NULL,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
      request uuid UNIQUE,
      error jsonb,
      credits_charged bigint NOT NULL DEFAULT 0,
      started_at timestamptz,
      finished_at timestamptz,
      PRIMARY KEY (batch, n)
    );
    CREATE INDEX IF NOT EXISTS fetch_batch_items_queued ON fetch_batch_items (host, batch, n) WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS fetch_batch_items_running ON fetch_batch_items (started_at) WHERE status = 'running';
    CREATE INDEX IF NOT EXISTS fetch_batch_items_finished ON fetch_batch_items (batch, finished_at, n) WHERE finished_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS batch_webhook_deliveries (
      id bigserial PRIMARY KEY,
      batch uuid NOT NULL REFERENCES fetch_batches (id) ON DELETE CASCADE,
      project text NOT NULL,
      event text NOT NULL CHECK (event IN ('batch.finished', 'batch.paused')),
      url bytea NOT NULL,
      attempts int NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      delivered_at timestamptz,
      gave_up_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS batch_webhook_deliveries_due ON batch_webhook_deliveries (next_attempt_at)
      WHERE delivered_at IS NULL AND gave_up_at IS NULL;
  `);
}

// Maps a mapper over items, at most `limit` at a time, keeping the order.
async function mapLimited(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await mapper(items[index]);
    }
  }));
  return out;
}

function cursorOf(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) throw new Error('cursor');
    return parsed;
  } catch { throw invalid('cursor'); }
}
const makeCursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
// A timestamp as text to the microsecond, as PostgreSQL keeps it: a cursor
// made from a JavaScript Date (milliseconds) would read rows twice.
const exactTime = column => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const validTime = value => typeof value === 'string' && !Number.isNaN(new Date(value).getTime());

export class BatchService {
  // front: FetchFront (starts items, reads results); engine: EngineClient.
  constructor({store, config, front, engine, ledger, limits = {}}) {
    Object.assign(this, {store, config, front, engine, ledger});
    this.limits = {...BATCH_LIMITS, ...limits};
    this.sealer = front.sealer;
    this.blocked = blockedHosts(config);
    // Wakes the queue runner: items were queued, or one finished (a host slot freed).
    this.kickRunner = () => {};
  }

  // ---------- submit ----------

  async submit(project, raw, {keyId = null} = {}) {
    const batch = expandBatch(raw, {blocked: this.blocked});
    const key = batch.idempotencyKey ?? randomUUID();
    if (batch.idempotencyKey) {
      const existing = await this.#byKey(project, key);
      if (existing) {
        if (existing.input_hash !== batch.hash) throw new GatewayError('idempotency_conflict', 409);
        return {batch: await this.#view(existing), created: false};
      }
    }
    // What the platform bills from, per item (max_credits); the rest is the engine's to check.
    for (const item of batch.items) {
      try { this.front.billingCheck(item.request); } catch (error) { throw this.#itemError(error, item, batch.defaults); }
    }
    const queued = (await this.store.pool.query(`SELECT count(*)::int AS n FROM fetch_batch_items i JOIN fetch_batches b ON b.id = i.batch
      WHERE b.project = $1 AND i.status = 'queued'`, [project])).rows[0].n;
    if (queued + batch.items.length > this.limits.maxQueuedPerProject) {
      throw Object.assign(new GatewayError('too_many_requests', 429), {details: {retry_after_seconds: 60, queued,
        max_queued: this.limits.maxQueuedPerProject}});
    }
    if (this.ledger.metered(project)) {
      const balance = await this.ledger.balance(project);
      if (balance?.held) throw new GatewayError('payment_hold', 402);
      const cheapest = Math.min(...Object.values(this.#stepPrices()));
      if ((balance?.available ?? 0) < cheapest) {
        throw Object.assign(new GatewayError('insufficient_credits', 402), {details: {available: balance?.available ?? 0, needed: cheapest}});
      }
    }
    const hosts = await this.#check(batch);
    const id = randomUUID();
    const inserted = await this.store.tx(async client => {
      const row = (await client.query(`INSERT INTO fetch_batches (id, project, key_id, idempotency_key, input_hash, defaults, webhook_url, tags, total)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (project, idempotency_key) DO NOTHING RETURNING *`,
      [id, project, keyId, key, batch.hash, this.sealer.seal(batch.defaults), batch.webhookUrl ? this.sealer.seal(batch.webhookUrl) : null,
        batch.tags, batch.items.length])).rows[0];
      if (!row) return null;
      const chunk = 500;
      for (let start = 0; start < batch.items.length; start += chunk) {
        const part = batch.items.slice(start, start + chunk);
        await client.query(`INSERT INTO fetch_batch_items (batch, n, host, input)
          SELECT $1, n, host, input FROM unnest($2::int[], $3::text[], $4::bytea[]) AS t(n, host, input)`,
        [id, part.map(item => item.index), part.map(item => hosts[item.index]), part.map(item => this.sealer.seal(item.own))]);
      }
      return row;
    });
    if (!inserted) {
      // The same key won a race.
      const existing = await this.#byKey(project, key);
      if (existing.input_hash !== batch.hash) throw new GatewayError('idempotency_conflict', 409);
      return {batch: await this.#view(existing), created: false};
    }
    this.kickRunner();
    return {batch: await this.#view(inserted), created: true};
  }

  #stepPrices() {
    const table = this.ledger.prices;
    return Object.fromEntries(['http', 'http_residential', 'browser', 'browser_residential'].map(step => [step, table[step]]));
  }

  // A refusal of one merged request, told with the field's place in the batch:
  // items[i].field when the item set it, else defaults.field.
  #itemError(error, item, defaults) {
    if (!(error instanceof GatewayError)) return error;
    const field = String(error.details?.field ?? 'url');
    const top = field.split(/[.[]/, 1)[0];
    const where = Object.hasOwn(item.own, top) || !Object.hasOwn(defaults, top) ? `items[${item.index}].${field}` : `defaults.${field}`;
    const refusal = new GatewayError(error.code, error.status ?? 400);
    refusal.details = {...error.details, field: where};
    return refusal;
  }

  // Every merged request, checked by the engine as a fetch would be; the
  // first refusal refuses the batch. Returns each item's host.
  async #check(batch) {
    const hosts = [];
    let part = [];
    let bytes = 0;
    const flush = async () => {
      if (!part.length) return;
      const results = await this.engine.checkRequests(part.map(item => item.request));
      results.forEach((result, offset) => {
        const item = part[offset];
        if (result.error) {
          const status = {url_not_allowed: 400, request_too_large: 413}[result.error.code] ?? 400;
          throw this.#itemError(Object.assign(new GatewayError(result.error.code, status), {details: result.error.details ?? {}}),
            item, batch.defaults);
        }
        hosts[item.index] = result.host;
      });
      part = [];
      bytes = 0;
    };
    for (const item of batch.items) {
      const size = Buffer.byteLength(JSON.stringify(item.request));
      if (part.length && (part.length >= this.limits.checkCount || bytes + size > this.limits.checkBytes)) await flush();
      part.push(item);
      bytes += size;
    }
    await flush();
    return hosts;
  }

  // ---------- reading ----------

  async #byKey(project, key) {
    return (await this.store.pool.query('SELECT * FROM fetch_batches WHERE project = $1 AND idempotency_key = $2', [project, key])).rows[0];
  }

  async #row(project, id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new GatewayError('not_found', 404);
    const row = (await this.store.pool.query('SELECT * FROM fetch_batches WHERE id = $1 AND project = $2', [id, project])).rows[0];
    if (!row) throw new GatewayError('not_found', 404);
    return row;
  }

  async #counts(ids, client = this.store.pool) {
    const rows = (await client.query(`SELECT batch, status, count(*)::int AS n, sum(credits_charged)::bigint AS credits
      FROM fetch_batch_items WHERE batch = ANY($1::uuid[]) GROUP BY batch, status`, [ids])).rows;
    const out = new Map(ids.map(id => [id, {counts: Object.fromEntries(ITEM_STATUSES.map(status => [status, 0])), credits: 0}]));
    for (const row of rows) {
      const entry = out.get(row.batch);
      entry.counts[row.status] = row.n;
      entry.credits += Number(row.credits ?? 0);
    }
    return out;
  }

  async #view(row, counts = null) {
    const {counts: items, credits} = counts ?? (await this.#counts([row.id])).get(row.id);
    return {
      id: row.id, status: row.status, paused_reason: row.paused_reason ?? null, idempotency_key: row.idempotency_key, tags: row.tags,
      created_at: iso(row.created_at), finished_at: iso(row.finished_at), canceled_at: iso(row.canceled_at),
      items: {total: row.total, ...items},
      credits: {charged: credits},
      webhook: row.webhook_url !== null,
    };
  }

  async get(project, id) {
    return this.#view(await this.#row(project, id));
  }

  async list(project, query = {}) {
    for (const key of Object.keys(query)) if (!['status', 'limit', 'cursor'].includes(key)) throw invalid(key, 'unknown query');
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('limit', '1 to 100');
    if (query.status !== undefined && !['running', 'paused', 'finished', 'canceled'].includes(query.status)) throw invalid('status');
    let cursor = null;
    if (query.cursor !== undefined) {
      const [at, id] = cursorOf(query.cursor);
      if (!validTime(at) || !UUID.test(String(id))) throw invalid('cursor');
      cursor = {at, id: String(id)};
    }
    const rows = (await this.store.pool.query(`SELECT *, ${exactTime('created_at')} AS created_key FROM fetch_batches WHERE project = $1 AND ($2::text IS NULL OR status = $2)
      AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid)) ORDER BY created_at DESC, id DESC LIMIT $5`,
    [project, query.status ?? null, cursor?.at ?? null, cursor?.id ?? null, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const counts = await this.#counts(page.map(row => row.id));
    const last = page.at(-1);
    return {items: await Promise.all(page.map(row => this.#view(row, counts.get(row.id)))),
      next_cursor: rows.length > limit ? makeCursor([last.created_key, last.id]) : null};
  }

  // A page of a batch's items, by index (the default) or in the order they
  // finished (order=finished: a feed; keep next_cursor to read only what
  // finished since). Finished items carry their result (the FetchResult,
  // without the body) unless results=false.
  async items(project, id, query = {}) {
    const row = await this.#row(project, id);
    for (const key of Object.keys(query)) if (!['status', 'order', 'limit', 'cursor', 'results'].includes(key)) throw invalid(key, 'unknown query');
    const order = query.order ?? 'index';
    if (!['index', 'finished'].includes(order)) throw invalid('order', 'index or finished');
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('limit', '1 to 100');
    if (query.status !== undefined && !ITEM_STATUSES.includes(query.status)) throw invalid('status');
    if (query.results !== undefined && !['true', 'false'].includes(String(query.results))) throw invalid('results', 'true or false');
    const withResults = String(query.results ?? 'true') === 'true';
    let rows;
    let nextCursor = null;
    if (order === 'index') {
      let after = -1;
      if (query.cursor !== undefined) {
        [after] = cursorOf(query.cursor);
        if (!Number.isSafeInteger(after)) throw invalid('cursor');
      }
      rows = (await this.store.pool.query(`SELECT * FROM fetch_batch_items WHERE batch = $1 AND n > $2
        AND ($3::text IS NULL OR status = $3) ORDER BY n LIMIT $4`, [row.id, after, query.status ?? null, limit + 1])).rows;
      if (rows.length > limit) nextCursor = makeCursor([rows[limit - 1].n]);
    } else {
      let after = null;
      if (query.cursor !== undefined) {
        const [at, n] = cursorOf(query.cursor);
        if (!validTime(at) || !Number.isSafeInteger(n)) throw invalid('cursor');
        after = {at, n};
      }
      // Items show in the feed a moment after they finish, so one whose
      // transaction commits after a later one's is never skipped.
      const done = ['finished', 'canceled'].includes(row.status) && row.finished_at;
      rows = (await this.store.pool.query(`SELECT *, ${exactTime('finished_at')} AS finished_key FROM fetch_batch_items
        WHERE batch = $1 AND finished_at IS NOT NULL
        AND ($2::timestamptz IS NULL OR (finished_at, n) > ($2, $3::int)) AND ($4::text IS NULL OR status = $4)
        AND ($6 OR finished_at <= clock_timestamp() - make_interval(secs => $7))
        ORDER BY finished_at, n LIMIT $5`, [row.id, after?.at ?? null, after?.n ?? null, query.status ?? null, limit + 1, !!done,
        FEED_LAG_MS / 1000])).rows;
      // A feed: the cursor after the last item read, so later reads get only
      // what finished since; null once the batch is over and all was read.
      const last = rows.slice(0, limit).at(-1);
      if (rows.length > limit || !done) {
        nextCursor = last ? makeCursor([last.finished_key, last.n]) : query.cursor ?? makeCursor([FEED_START, -1]);
      }
    }
    const page = rows.slice(0, limit);
    const items = await mapLimited(page, this.limits.resultReads, item => this.#itemView(project, item, withResults));
    return {items, next_cursor: nextCursor};
  }

  async #itemView(project, item, withResult) {
    const own = this.sealer.open(item.input);
    let result = null;
    if (withResult && item.request && ['succeeded', 'failed'].includes(item.status)) {
      try { result = await this.front.get(project, item.request, {includeBody: false}); } catch (error) {
        if (!(error instanceof GatewayError) || error.code !== 'not_found') throw error;
      }
    }
    return {index: item.n, url: own.url, status: item.status, request_id: item.request ?? null,
      credits: {charged: Number(item.credits_charged)}, error: item.error ?? null, started_at: iso(item.started_at),
      finished_at: iso(item.finished_at), result};
  }

  // Stops a batch: queued items are canceled, running ones finish (and are
  // charged if they succeed). Canceling a batch that is over changes nothing.
  async cancel(project, id) {
    const row = await this.#row(project, id);
    let queued = false;
    await this.store.tx(async client => {
      const current = (await client.query('SELECT * FROM fetch_batches WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
      if (['finished', 'canceled'].includes(current.status)) return;
      await client.query(`UPDATE fetch_batch_items SET status = 'canceled', finished_at = clock_timestamp()
        WHERE batch = $1 AND status = 'queued'`, [row.id]);
      await client.query(`UPDATE fetch_batches SET status = 'canceled', canceled_at = clock_timestamp(), paused_reason = NULL,
        paused_needed = NULL WHERE id = $1`, [row.id]);
      queued = await this.#finishIfDone(client, row.id);
    });
    if (queued) this.front.onSettled();
    return this.get(project, id);
  }

  // ---------- hooks FetchFront calls inside its transactions ----------

  // Marks a queued item running as job `request`, in the transaction that
  // reserves for it. False when the item is no longer queued, or its batch is
  // no longer running (canceled or paused since the runner picked it).
  async claim(client, {batch, index}, request) {
    const claimed = await client.query(`UPDATE fetch_batch_items i SET status = 'running', request = $3, started_at = clock_timestamp(),
      error = NULL FROM fetch_batches b WHERE i.batch = $1 AND i.n = $2 AND i.status = 'queued' AND b.id = i.batch AND b.status = 'running'`,
    [batch, index, request]);
    return claimed.rowCount === 1;
  }

  // A settled job: if it was a batch item, the item takes its outcome, the
  // batch's webhook gets it, and the batch ends when it was the last one.
  // Returns {item, webhook}: whether it was an item, and whether a delivery was queued.
  async settled(client, settlement) {
    const item = (await client.query(`SELECT batch, n FROM fetch_batch_items WHERE request = $1`, [settlement.request])).rows[0];
    if (!item) return {item: false, webhook: false};
    const batch = (await client.query('SELECT * FROM fetch_batches WHERE id = $1 FOR UPDATE', [item.batch])).rows[0];
    const updated = await client.query(`UPDATE fetch_batch_items SET status = $3, credits_charged = $4, finished_at = clock_timestamp()
      WHERE batch = $1 AND n = $2 AND status = 'running'`, [item.batch, item.n, settlement.status, settlement.credits_charged]);
    if (updated.rowCount !== 1) return {item: true, webhook: false};
    let webhook = false;
    if (batch.webhook_url) {
      await client.query('INSERT INTO webhook_deliveries (request, project, url) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [settlement.request, batch.project, batch.webhook_url]);
      webhook = true;
    }
    return {item: true, webhook: await this.#finishIfDone(client, item.batch) || webhook};
  }

  // A job that never started (refused by the engine, or unknown to it): its
  // item goes back to the queue, or is canceled if its batch was.
  async discarded(client, request) {
    const item = (await client.query(`SELECT batch, n FROM fetch_batch_items WHERE request = $1`, [request])).rows[0];
    if (!item) return false;
    const batch = (await client.query('SELECT status FROM fetch_batches WHERE id = $1 FOR UPDATE', [item.batch])).rows[0];
    await client.query(`UPDATE fetch_batch_items SET status = $3, request = NULL, started_at = NULL,
      finished_at = CASE WHEN $3 = 'canceled' THEN clock_timestamp() END WHERE batch = $1 AND n = $2 AND status = 'running'`,
    [item.batch, item.n, batch.status === 'canceled' ? 'canceled' : 'queued']);
    return this.#finishIfDone(client, item.batch);
  }

  // Ends a batch with nothing left to run, and queues batch.finished. The
  // caller holds the batch row's lock. Returns whether a delivery was queued.
  async #finishIfDone(client, id) {
    const batch = (await client.query('SELECT * FROM fetch_batches WHERE id = $1', [id])).rows[0];
    if (!batch || batch.finished_at) return false;
    const left = (await client.query(`SELECT count(*) FILTER (WHERE status = 'running')::int AS running,
      count(*) FILTER (WHERE status = 'queued')::int AS queued FROM fetch_batch_items WHERE batch = $1`, [id])).rows[0];
    if (left.running || (left.queued && batch.status !== 'canceled')) return false;
    await client.query(`UPDATE fetch_batches SET status = CASE WHEN status = 'canceled' THEN 'canceled' ELSE 'finished' END,
      finished_at = clock_timestamp(), paused_reason = NULL, paused_needed = NULL WHERE id = $1`, [id]);
    return this.#queueEvent(client, batch, 'batch.finished');
  }

  async #queueEvent(client, batch, event) {
    if (!batch.webhook_url) return false;
    await client.query('INSERT INTO batch_webhook_deliveries (batch, project, event, url) VALUES ($1, $2, $3, $4)',
      [batch.id, batch.project, event, batch.webhook_url]);
    return true;
  }

  // ---------- the queue (driven by BatchRunner) ----------

  // Queued items by host: [{host, batch, project}], oldest batches first.
  async queuedPairs() {
    return (await this.store.pool.query(`SELECT i.host, i.batch, b.project FROM fetch_batch_items i JOIN fetch_batches b ON b.id = i.batch
      WHERE i.status = 'queued' AND b.status = 'running' GROUP BY i.host, i.batch, b.project, b.created_at
      ORDER BY b.created_at, i.batch LIMIT $1`, [this.limits.tickPairs])).rows;
  }

  // Requests each project may still start for its batches: its limit of
  // requests at once, less one kept for single requests, less what runs now.
  async projectRoom(projects) {
    if (!projects.length) return new Map();
    const running = new Map((await this.store.pool.query(`SELECT project, count(*)::int AS n FROM fetch_settlements
      WHERE status = 'pending' AND project = ANY($1::text[]) GROUP BY project`, [projects])).rows.map(row => [row.project, row.n]));
    return new Map(projects.map(project => {
      const cap = this.config.projects?.[project]?.maxConcurrentRequests ?? budget(this.config, 'fetch.maxConcurrentPerProject');
      return [project, Math.max(0, (cap > 1 ? cap - 1 : cap) - (running.get(project) ?? 0))];
    }));
  }

  // Starts the next queued item of `batch` on `host`. Returns what happened:
  // started, none (nothing queued there now), host_busy, project_full,
  // paused, refused (the item failed without starting) or engine_down.
  async startNext({batch: id, host}) {
    const item = (await this.store.pool.query(`SELECT n, input FROM fetch_batch_items WHERE batch = $1 AND host = $2 AND status = 'queued'
      ORDER BY n LIMIT 1`, [id, host])).rows[0];
    if (!item) return 'none';
    const batch = (await this.store.pool.query('SELECT * FROM fetch_batches WHERE id = $1', [id])).rows[0];
    if (batch?.status !== 'running') return 'none';
    const request = {...this.sealer.open(batch.defaults), ...this.sealer.open(item.input), async: true,
      idempotency_key: itemKey(batch.id, item.n)};
    try {
      const view = await this.front.startBatchItem(batch.project, request, {keyId: batch.key_id, batch: batch.id, index: item.n});
      return view ? 'started' : 'none';
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      if (error.code === 'host_busy') return 'host_busy';
      // The project is at its limit of requests at once, or its running
      // requests hold the credits this item would reserve: wait for them.
      if (error.code === 'too_many_requests' || error.code === 'credits_busy') return 'project_full';
      if (error.code === 'unavailable') return 'engine_down';
      if (['insufficient_credits', 'payment_hold'].includes(error.code)) {
        await this.#pause(batch.id, error.code, error.details?.needed ?? null);
        return 'paused';
      }
      if (ITEM_REFUSALS.has(error.code)) {
        await this.#refuse(batch.id, item.n, error);
        return 'refused';
      }
      throw error;
    }
  }

  async #pause(id, reason, needed) {
    let queued = false;
    await this.store.tx(async client => {
      const batch = (await client.query(`UPDATE fetch_batches SET status = 'paused', paused_reason = $2, paused_needed = $3
        WHERE id = $1 AND status = 'running' RETURNING *`, [id, reason, needed])).rows[0];
      if (batch) queued = await this.#queueEvent(client, batch, 'batch.paused');
    });
    if (queued) this.front.onSettled();
  }

  async #refuse(id, index, error) {
    let queued = false;
    await this.store.tx(async client => {
      await client.query('SELECT 1 FROM fetch_batches WHERE id = $1 FOR UPDATE', [id]);
      const refused = await client.query(`UPDATE fetch_batch_items SET status = 'failed', finished_at = clock_timestamp(), error = $3
        WHERE batch = $1 AND n = $2 AND status = 'queued'`, [id, index, {code: error.code, message: refusalMessage(error.code),
        ...(error.details ? {details: error.details} : {})}]);
      if (refused.rowCount === 1) queued = await this.#finishIfDone(client, id);
    });
    if (queued) this.front.onSettled();
  }

  // Paused batches start again once the project's balance covers what their
  // next item needed (or the payment hold is gone).
  async resumePaused() {
    const rows = (await this.store.pool.query(`SELECT id, project, paused_reason, paused_needed FROM fetch_batches WHERE status = 'paused'
      ORDER BY created_at LIMIT 500`)).rows;
    let resumed = 0;
    const balances = new Map();
    for (const row of rows) {
      if (!balances.has(row.project)) balances.set(row.project, await this.ledger.balance(row.project));
      const balance = balances.get(row.project);
      const needed = Number(row.paused_needed ?? Math.min(...Object.values(this.#stepPrices())));
      if (balance && (balance.held || balance.available < needed)) continue;
      const updated = await this.store.pool.query(`UPDATE fetch_batches SET status = 'running', paused_reason = NULL, paused_needed = NULL
        WHERE id = $1 AND status = 'paused'`, [row.id]);
      resumed += updated.rowCount;
    }
    return resumed;
  }

  // Items marked running whose job never got a settlement row (the platform
  // stopped between claiming and reserving) go back to the queue. Their key
  // is the item's own, so the engine never runs one twice.
  async requeueOrphans() {
    const rows = (await this.store.pool.query(`SELECT i.request FROM fetch_batch_items i WHERE i.status = 'running'
      AND i.started_at < clock_timestamp() - make_interval(secs => $1)
      AND NOT EXISTS (SELECT 1 FROM fetch_settlements s WHERE s.request = i.request) LIMIT 500`, [this.limits.orphanMs / 1000])).rows;
    for (const row of rows) await this.store.tx(client => this.discarded(client, row.request));
    return rows.length;
  }

  // Links an item to the job its key already had (a restart after an
  // uncertain start that the engine did take), with that job's outcome so far.
  async linkExisting({batch, index}, request) {
    let queued = false;
    await this.store.tx(async client => {
      await client.query('SELECT 1 FROM fetch_batches WHERE id = $1 FOR UPDATE', [batch]);
      const settlement = (await client.query('SELECT * FROM fetch_settlements WHERE request = $1', [request])).rows[0];
      const status = !settlement ? 'failed' : settlement.status === 'pending' ? 'running' : settlement.status;
      await client.query(`UPDATE fetch_batch_items SET status = $3, request = $4, credits_charged = $5,
        started_at = coalesce(started_at, clock_timestamp()), finished_at = CASE WHEN $3 <> 'running' THEN clock_timestamp() END,
        error = $6 WHERE batch = $1 AND n = $2 AND status IN ('queued', 'running')`,
      [batch, index, status, request, Number(settlement?.credits_charged ?? 0),
        settlement ? null : {code: 'uncertain', message: refusalMessage('uncertain')}]);
      if (status !== 'running') queued = await this.#finishIfDone(client, batch);
    });
    if (queued) this.front.onSettled();
  }

  async prune() {
    await this.store.pool.query(`DELETE FROM fetch_batches WHERE status IN ('finished', 'canceled') AND finished_at IS NOT NULL
      AND created_at < now() - make_interval(days => $1)`, [this.limits.metadataDays]);
  }

  // ---------- webhooks ----------

  async dueEvents(limit) {
    return (await this.store.pool.query(`SELECT id, batch, project, event, url, attempts FROM batch_webhook_deliveries
      WHERE delivered_at IS NULL AND gave_up_at IS NULL AND next_attempt_at <= clock_timestamp() ORDER BY next_attempt_at LIMIT $1`,
    [limit])).rows;
  }
}

const REFUSALS = {
  invalid_request: 'The item was refused before it started; error.details.field names the field.',
  url_not_allowed: 'The item\'s URL must be public http or https and must not resolve to a private address.',
  request_too_large: 'The item is too large.',
  max_credits_too_low: 'The item\'s max_credits is below the cheapest step it could take; see error.details.min_credits.',
  idempotency_conflict: 'The item\'s key was already used by another request.',
  uncertain: 'FetchX could not tell whether this item started; it was not charged.',
};
const refusalMessage = code => REFUSALS[code] ?? 'The item was refused before it started.';

// The queue. Each tick: resume paused batches the balance now covers, ask
// the engine how fast each host with queued items may take work, and start
// what fits, taking turns between the batches waiting on the same host.
export class BatchRunner {
  constructor({batches, engine, intervalMs = 1000, now = Date.now}) {
    Object.assign(this, {batches, engine, intervalMs, now});
    this.running = null;
    this.again = false;
    this.soon = null;
    // `${host} ${batch}` -> when an item of that batch last started on that host.
    this.served = new Map();
    this.lastOrphanSweep = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref();
    this.kick();
  }

  kick() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.tick().catch(error => {
      process.stderr.write(JSON.stringify({event: 'batch_tick_failed', code: error?.code ?? null, name: error?.name ?? null}) + '\n');
      return {started: 0};
    }).then(result => {
      if (result.next_in_ms) this.#wakeIn(result.next_in_ms);
      return result;
    }).finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.kick();
      }
    });
    return this.running;
  }

  // A host whose next start is due before the next round is looked at again
  // then, so spaced starts keep to the engine's gap and not to the interval.
  // Only while the runner is started (tests drive tick() themselves).
  #wakeIn(ms) {
    if (!this.timer || this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.kick();
    }, Math.max(50, ms));
    this.soon.unref();
  }

  async tick() {
    await this.batches.resumePaused();
    if (this.now() - this.lastOrphanSweep > 60_000) {
      this.lastOrphanSweep = this.now();
      await this.batches.requeueOrphans();
    }
    const pairs = await this.batches.queuedPairs();
    if (!pairs.length) return {started: 0};
    const byHost = new Map();
    for (const pair of pairs) byHost.set(pair.host, [...(byHost.get(pair.host) ?? []), pair]);
    const hosts = [...byHost.keys()];
    const pace = {};
    let browserWaiting = 0;
    for (let start = 0; start < hosts.length; start += this.batches.limits.paceHosts) {
      const answer = await this.engine.pace(hosts.slice(start, start + this.batches.limits.paceHosts));
      Object.assign(pace, answer.hosts);
      browserWaiting = Math.max(browserWaiting, answer.browser_waiting ?? 0);
    }
    // Items should not queue for a browser: let the jobs ahead of them through first.
    if (browserWaiting > 0) return {started: 0, browser_waiting: browserWaiting};
    const room = await this.batches.projectRoom([...new Set(pairs.map(pair => pair.project))]);
    // Starts each host may take now: all its free slots, or one when its
    // starts are spaced out.
    const left = new Map();
    // The soonest a host with free slots may start again, if before the next round.
    let soon = null;
    const dueIn = ms => { if (ms > 0 && ms < this.intervalMs && (soon === null || ms < soon)) soon = ms; };
    for (const host of hosts) {
      const state = pace[host];
      const free = state ? Math.max(0, state.max_running - state.running) : 0;
      if (free > 0 && state.next_start_in_ms > 0) dueIn(state.next_start_in_ms);
      if (free > 0 && state.next_start_in_ms === 0) left.set(host, state.start_gap_ms === 0 ? free : 1);
    }
    // One start per host per round, so the hosts take turns with each
    // project's room.
    let started = 0;
    for (let again = true; again;) {
      again = false;
      for (const [host, count] of left) {
        const outcome = await this.#startOn(host, byHost.get(host), room);
        if (outcome === 'engine_down') return {started};
        if (outcome !== 'started' || count === 1) left.delete(host);
        else left.set(host, count - 1);
        if (outcome === 'started') {
          started++;
          again = true;
          const state = pace[host];
          if (state.start_gap_ms > 0 && state.max_running - state.running > 1) dueIn(state.start_gap_ms);
        }
      }
    }
    return soon === null ? {started} : {started, next_in_ms: soon};
  }

  // Starts one item on `host`, from the batch that host served least
  // recently among those whose project has room: started, host_busy,
  // engine_down, or none (nothing it can start now).
  async #startOn(host, candidates, room) {
    for (;;) {
      const candidate = candidates.filter(pair => (room.get(pair.project) ?? 0) > 0)
        .sort((a, b) => (this.served.get(`${host} ${a.batch}`) ?? 0) - (this.served.get(`${host} ${b.batch}`) ?? 0))[0];
      if (!candidate) return 'none';
      const outcome = await this.batches.startNext(candidate);
      if (outcome === 'engine_down' || outcome === 'host_busy') return outcome;
      if (outcome === 'project_full') {
        room.set(candidate.project, 0);
        continue;
      }
      if (outcome === 'none' || outcome === 'paused') {
        candidates.splice(candidates.indexOf(candidate), 1);
        continue;
      }
      // An item refused at its start failed alone: try the batch's next.
      if (outcome === 'refused') continue;
      const key = `${host} ${candidate.batch}`;
      this.served.delete(key);
      this.served.set(key, this.now());
      if (this.served.size > 50_000) this.served.delete(this.served.keys().next().value);
      room.set(candidate.project, (room.get(candidate.project) ?? 1) - 1);
      return 'started';
    }
  }

  async close() {
    clearInterval(this.timer);
    clearTimeout(this.soon);
    this.timer = this.soon = null;
    await this.running;
  }
}
