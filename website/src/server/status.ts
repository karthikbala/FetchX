// The public status page. A scheduled Worker (ops/retention-worker.ts) reads the
// API's GET /v1/status every minute and records what it saw in D1; GET
// /api/status (functions/api/status.ts) serves the page from those records.
// Neither runs on FetchX's own servers, so the page still says when the API
// does not answer, and keeps 90 days of history.

export type ServiceState = 'operational' | 'degraded' | 'partial_outage' | 'maintenance' | 'major_outage';
export type CheckState = ServiceState | 'unreachable';
export type NoticeUpdate = { at: string; text: string };
export type Notice = {
  id: string; kind: 'incident' | 'maintenance'; title: string; body: string; impact: string; components: string[];
  pause_api: boolean; status: 'scheduled' | 'active' | 'resolved'; starts_at: string; ends_at: string | null;
  resolved_at: string | null; updates: NoticeUpdate[];
};
export type Component = { id: string; name: string; status: ServiceState | 'unknown' };
export type ApiStatus = {
  status: ServiceState; updated_at: string; components: Component[]; notices: Notice[];
  api: { version: string | null }; links: Record<string, string>;
};
export type Check = {
  at: number; ok: boolean; http_status: number | null; latency_ms: number | null; error: string | null; payload: ApiStatus | null;
};
export type Day = {
  date: string; checks: number; uptime: number | null; down_minutes: number;
  level: 'operational' | 'degraded' | 'maintenance' | 'outage' | 'no_data';
};
export type Outage = { started_at: string; ended_at: string | null; minutes: number; ongoing: boolean };
export type PublicStatus = {
  status: ServiceState | 'unknown'; checked_at: string | null; answered_at: string | null;
  monitor: { interval_seconds: number; failures: number; stale: boolean };
  components: Component[]; notices: Notice[]; outages: Outage[]; days: Day[];
  uptime: { days_90: number | null }; api: { version: string | null }; links: Record<string, string>;
};

export const STATUS_URL = 'https://app.fetchx.ai/v1/status';
export const STATUS_CRON = '* * * * *';
export const CHECK_TIMEOUT_MS = 10_000;
export const HISTORY_DAYS = 90;
const CHECKS_KEPT_DAYS = 7;
// No check for this long: the monitor itself has stopped, so the page says "unknown".
const STALE_SECONDS = 5 * 60;
// A maintenance notice without an end covers an unanswered API for this long after its last answer.
const OPEN_MAINTENANCE_SECONDS = 4 * 3600;
// After a maintenance notice's planned end, unanswered checks still count as maintenance for this long.
const MAINTENANCE_GRACE_SECONDS = 10 * 60;
const STATES: ServiceState[] = ['operational', 'degraded', 'partial_outage', 'maintenance', 'major_outage'];
const DEFAULT_COMPONENTS = [{ id: 'api', name: 'API' }, { id: 'fetching', name: 'Fetching' }, { id: 'console', name: 'Console and billing' }];
const DEFAULT_LINKS = { status_page: 'https://fetchx.ai/status', changelog: 'https://fetchx.ai/changelog', docs: 'https://fetchx.ai/docs' };

const seconds = (ms: number) => Math.floor(ms / 1000);
const iso = (unix: number | null | undefined) => unix == null ? null : new Date(unix * 1000).toISOString();
const dayOf = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
const time = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function parseNotice(value: unknown): Notice | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[0-9]{1,18}$/.test(value.id)) return null;
  const startsAt = time(value.starts_at);
  if (!startsAt || (value.kind !== 'incident' && value.kind !== 'maintenance')) return null;
  return {
    id: value.id, kind: value.kind, title: text(value.title, 200), body: text(value.body, 4000), impact: text(value.impact, 20),
    components: Array.isArray(value.components) ? value.components.filter((id): id is string => typeof id === 'string').slice(0, 10).map(id => id.slice(0, 40)) : [],
    pause_api: value.pause_api === true,
    status: value.status === 'scheduled' || value.status === 'resolved' ? value.status : 'active',
    starts_at: startsAt, ends_at: time(value.ends_at), resolved_at: time(value.resolved_at),
    updates: (Array.isArray(value.updates) ? value.updates : []).slice(-50).flatMap(update => {
      const at = isRecord(update) ? time(update.at) : null;
      return at && isRecord(update) ? [{ at, text: text(update.text, 4000) }] : [];
    }),
  };
}

// The API's answer, kept to the fields the page shows; null when it is not a status answer.
export function parseStatus(value: unknown): ApiStatus | null {
  if (!isRecord(value) || !STATES.includes(value.status as ServiceState) || !Array.isArray(value.components)) return null;
  const components = value.components.flatMap(component => isRecord(component) && typeof component.id === 'string'
    && STATES.includes(component.status as ServiceState)
    ? [{ id: component.id.slice(0, 40), name: text(component.name, 80) || component.id.slice(0, 40), status: component.status as ServiceState }] : []);
  const links: Record<string, string> = { ...DEFAULT_LINKS };
  if (isRecord(value.links)) {
    for (const [key, link] of Object.entries(value.links)) {
      if (key in DEFAULT_LINKS && typeof link === 'string' && /^https:\/\/[^\s]{1,300}$/.test(link)) links[key] = link;
    }
  }
  return {
    status: value.status as ServiceState, updated_at: time(value.updated_at) ?? new Date().toISOString(), components,
    notices: (Array.isArray(value.notices) ? value.notices : []).slice(0, 100).map(parseNotice).filter((notice): notice is Notice => !!notice),
    api: { version: isRecord(value.api) && typeof value.api.version === 'string' ? value.api.version.slice(0, 20) : null },
    links,
  };
}

// One check of the API's GET /v1/status. Never throws: a failure is a check that did not answer.
export async function checkApi(url = STATUS_URL, fetcher: typeof fetch = fetch, now = Date.now): Promise<Check> {
  const started = now();
  const at = seconds(started);
  try {
    const response = await fetcher(url, {
      headers: { accept: 'application/json', 'user-agent': 'FetchX-status-monitor/1' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), redirect: 'manual',
    });
    const latency = now() - started;
    if (response.status !== 200) {
      await response.body?.cancel();
      return { at, ok: false, http_status: response.status, latency_ms: latency, error: `http_${response.status}`, payload: null };
    }
    const payload = parseStatus(await response.json().catch(() => null));
    return payload
      ? { at, ok: true, http_status: 200, latency_ms: now() - started, error: null, payload }
      : { at, ok: false, http_status: 200, latency_ms: now() - started, error: 'invalid_body', payload: null };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { at, ok: false, http_status: null, latency_ms: null, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', payload: null };
  }
}

type SnapshotRow = { checked_at: number; answered_at: number | null; failures: number; payload_json: string | null };
const readSnapshot = (db: D1Database) => db.prepare('SELECT * FROM status_snapshot WHERE id = 1').first<SnapshotRow>();
const payloadOf = (row: SnapshotRow | null): ApiStatus | null => row?.payload_json ? parseStatus(JSON.parse(row.payload_json)) : null;

const phase = (notice: Notice, now: number): Notice['status'] =>
  notice.resolved_at ? 'resolved' : Date.parse(notice.starts_at) > now * 1000 ? 'scheduled' : 'active';

// Whether planned maintenance, as the API last described it, explains an API that does not answer at `now`.
export function maintenanceCovers(payload: ApiStatus | null, answeredAt: number | null, now: number): boolean {
  return !!payload?.notices.some(notice => notice.kind === 'maintenance' && phase(notice, now) === 'active'
    && (notice.ends_at ? now <= seconds(Date.parse(notice.ends_at)) + MAINTENANCE_GRACE_SECONDS
      : answeredAt != null && now <= answeredAt + OPEN_MAINTENANCE_SECONDS));
}

const BUCKET: Record<CheckState, 'operational' | 'degraded' | 'maintenance' | 'down'> = {
  operational: 'operational', degraded: 'degraded', partial_outage: 'degraded', maintenance: 'maintenance',
  major_outage: 'down', unreachable: 'down',
};
const countDay = (db: D1Database, day: string, column: 'operational' | 'degraded' | 'maintenance' | 'down' | 'missed') =>
  db.prepare(`INSERT INTO status_days (day, checks, ${column}) VALUES (?, 1, 1)
    ON CONFLICT(day) DO UPDATE SET checks = checks + 1, ${column} = ${column} + 1`).bind(day);

// Records one check: the minute's row, the day's counts, outages, the snapshot and the notices it showed.
export async function recordCheck(db: D1Database, check: Check): Promise<{ state: CheckState; failures: number }> {
  const [snapshot, previous, open] = await Promise.all([
    readSnapshot(db),
    db.prepare('SELECT checked_at, state FROM status_checks ORDER BY checked_at DESC LIMIT 1').first<{ checked_at: number; state: CheckState }>(),
    db.prepare('SELECT started_at FROM status_outages WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').first<{ started_at: number }>(),
  ]);
  if (previous && previous.checked_at >= check.at) return { state: previous.state, failures: snapshot?.failures ?? 0 };
  const day = dayOf(check.at);
  const failures = check.ok ? 0 : (snapshot?.failures ?? 0) + 1;
  const covered = !check.ok && maintenanceCovers(payloadOf(snapshot), snapshot?.answered_at ?? null, check.at);
  const state: CheckState = check.payload ? check.payload.status : covered ? 'maintenance' : 'unreachable';
  const statements: D1PreparedStatement[] = [
    db.prepare('INSERT INTO status_checks (checked_at, state, http_status, latency_ms, error) VALUES (?, ?, ?, ?, ?)')
      .bind(check.at, state, check.http_status, check.latency_ms, check.error),
  ];
  if (state !== 'unreachable') {
    statements.push(countDay(db, day, BUCKET[state]));
    if (open) statements.push(db.prepare('UPDATE status_outages SET ended_at = ? WHERE started_at = ?').bind(check.at, open.started_at));
  } else if (open) {
    statements.push(countDay(db, day, 'down'),
      db.prepare('UPDATE status_outages SET checks = checks + 1 WHERE started_at = ?').bind(open.started_at));
  } else if (previous?.state === 'unreachable') {
    // The second unanswered check in a row: an outage that began at the first one, which now counts as down too.
    statements.push(countDay(db, day, 'down'),
      db.prepare('UPDATE status_days SET missed = max(missed - 1, 0), down = down + 1 WHERE day = ?').bind(dayOf(previous.checked_at)),
      db.prepare('INSERT OR IGNORE INTO status_outages (started_at, checks) VALUES (?, 2)').bind(previous.checked_at));
  } else {
    statements.push(countDay(db, day, 'missed'));
  }
  statements.push(db.prepare(`INSERT INTO status_snapshot (id, checked_at, answered_at, failures, payload_json) VALUES (1, ?1, ?2, ?3, ?4)
    ON CONFLICT(id) DO UPDATE SET checked_at = ?1, answered_at = coalesce(?2, answered_at), failures = ?3, payload_json = coalesce(?4, payload_json)`)
    .bind(check.at, check.ok ? check.at : null, failures, check.payload ? JSON.stringify(check.payload) : null));
  for (const notice of check.payload?.notices ?? []) {
    statements.push(db.prepare(`INSERT INTO status_notices (id, starts_at, resolved_at, payload_json, seen_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(id) DO UPDATE SET starts_at = ?2, resolved_at = ?3, payload_json = ?4, seen_at = ?5 WHERE payload_json <> ?4`)
      .bind(notice.id, notice.starts_at, notice.resolved_at, JSON.stringify(notice), check.at));
  }
  if (check.at % 3600 < 60) {
    // Once an hour: drop what the page no longer shows.
    const keep = check.at - HISTORY_DAYS * 86400;
    statements.push(
      db.prepare('DELETE FROM status_checks WHERE checked_at < ?').bind(check.at - CHECKS_KEPT_DAYS * 86400),
      db.prepare('DELETE FROM status_days WHERE day < ?').bind(dayOf(keep)),
      db.prepare('DELETE FROM status_outages WHERE ended_at IS NOT NULL AND ended_at < ?').bind(keep),
      db.prepare('DELETE FROM status_notices WHERE resolved_at IS NOT NULL AND resolved_at < ?').bind(iso(keep)),
    );
  }
  await db.batch(statements);
  return { state, failures };
}

type DayRow = { day: string; checks: number; operational: number; degraded: number; maintenance: number; down: number; missed: number };
type OutageRow = { started_at: number; ended_at: number | null; checks: number };

function dayLevel(row: DayRow | undefined): Day['level'] {
  if (!row || !row.checks) return 'no_data';
  if (row.down) return 'outage';
  if (row.degraded) return 'degraded';
  if (row.maintenance) return 'maintenance';
  return 'operational';
}

// What GET /api/status answers: the state now, notices, outages and 90 days, oldest first.
export async function publicStatus(db: D1Database, nowMs = Date.now()): Promise<PublicStatus> {
  const now = seconds(nowMs);
  const since = now - (HISTORY_DAYS - 1) * 86400;
  const [snapshot, dayRows, outageRows, noticeRows] = await Promise.all([
    readSnapshot(db),
    db.prepare('SELECT * FROM status_days WHERE day >= ? ORDER BY day').bind(dayOf(since)).all<DayRow>(),
    db.prepare('SELECT * FROM status_outages WHERE ended_at IS NULL OR ended_at >= ? ORDER BY started_at DESC LIMIT 50').bind(since).all<OutageRow>(),
    db.prepare(`SELECT payload_json FROM status_notices WHERE resolved_at IS NULL OR resolved_at >= ?
      ORDER BY (resolved_at IS NULL) DESC, starts_at DESC LIMIT 50`).bind(iso(since)).all<{ payload_json: string }>(),
  ]);
  const payload = payloadOf(snapshot);
  const failures = snapshot?.failures ?? 0;
  const stale = !snapshot || now - snapshot.checked_at > STALE_SECONDS;
  const known = new Map(dayRows.results.map(row => [row.day, row]));
  const days: Day[] = Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const date = dayOf(since + index * 86400);
    const row = known.get(date);
    return { date, checks: row?.checks ?? 0, uptime: row?.checks ? (row.checks - row.down) / row.checks : null,
      down_minutes: row?.down ?? 0, level: dayLevel(row) };
  });
  const totals = dayRows.results.reduce((sum, row) => ({ checks: sum.checks + row.checks, down: sum.down + row.down }), { checks: 0, down: 0 });
  const notices = noticeRows.results.map(row => parseNotice(JSON.parse(row.payload_json))).filter((notice): notice is Notice => !!notice)
    .map(notice => ({ ...notice, status: phase(notice, now) }));
  let status: PublicStatus['status'];
  let components: Component[];
  if (stale) {
    status = 'unknown';
    components = (payload?.components ?? DEFAULT_COMPONENTS).map(component => ({ id: component.id, name: component.name, status: 'unknown' }));
  } else if (failures >= 2 || (failures >= 1 && !payload)) {
    status = maintenanceCovers(payload, snapshot.answered_at, now) ? 'maintenance' : 'major_outage';
    components = (payload?.components ?? DEFAULT_COMPONENTS).map(component => ({ id: component.id, name: component.name, status }));
  } else if (payload) {
    status = payload.status;
    components = payload.components;
  } else {
    status = 'unknown';
    components = DEFAULT_COMPONENTS.map(component => ({ ...component, status: 'unknown' }));
  }
  return {
    status, checked_at: iso(snapshot?.checked_at), answered_at: iso(snapshot?.answered_at),
    monitor: { interval_seconds: 60, failures, stale },
    components, notices,
    outages: outageRows.results.map(row => ({ started_at: iso(row.started_at)!, ended_at: iso(row.ended_at),
      minutes: Math.max(1, Math.round(((row.ended_at ?? now) - row.started_at) / 60)), ongoing: row.ended_at == null })),
    days, uptime: { days_90: totals.checks ? (totals.checks - totals.down) / totals.checks : null },
    api: payload?.api ?? { version: null }, links: payload?.links ?? DEFAULT_LINKS,
  };
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
  'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30',
};

// GET /api/status, cached at the edge for 30 seconds so the page costs D1 at most two reads a minute.
export async function handleStatus(request: Request, env: { DB: D1Database }, ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { ...JSON_HEADERS, Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  }
  const key = new Request(new URL('/api/status', request.url).href);
  const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default;
  let response = await cache?.match(key).catch(() => undefined);
  if (!response) {
    try {
      response = new Response(JSON.stringify(await publicStatus(env.DB)), { headers: JSON_HEADERS });
    } catch {
      return Response.json({ error: 'status_unavailable' }, { status: 503, headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store', 'Retry-After': '30' } });
    }
    const stored = cache?.put(key, response.clone()).catch(() => undefined);
    if (stored) ctx?.waitUntil(stored);
  }
  return request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response;
}

// The scheduled check: one request to the API, recorded in every database given.
export async function monitorStatus(databases: D1Database[], url = STATUS_URL, fetcher: typeof fetch = fetch) {
  const check = await checkApi(url, fetcher);
  const recorded = await Promise.allSettled(databases.map(db => recordCheck(db, check)));
  return { at: iso(check.at), ok: check.ok, error: check.error, latency_ms: check.latency_ms,
    recorded: recorded.map(result => result.status === 'fulfilled' ? result.value.state : 'record_failed') };
}
