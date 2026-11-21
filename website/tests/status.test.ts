import {beforeEach, describe, expect, it} from 'vitest';
import {env} from 'cloudflare:workers';
import {applyD1Migrations, reset, type D1Migration} from 'cloudflare:test';
import {checkApi, handleStatus, monitorStatus, parseStatus, publicStatus, recordCheck, type ApiStatus, type Check} from '../src/server/status';

const db = env.DB;
// 2026-11-21 10:00:00 UTC, on a minute boundary that is not the hourly purge.
const T0 = Date.UTC(2026, 10, 21, 10, 1, 0) / 1000;
const operational = (overrides: Partial<ApiStatus> = {}): ApiStatus => ({
  status: 'operational', updated_at: new Date(T0 * 1000).toISOString(),
  components: [{id: 'api', name: 'API', status: 'operational'}, {id: 'fetching', name: 'Fetching', status: 'operational'}],
  notices: [], api: {version: '1.4.0'}, links: {status_page: 'https://fetchx.ai/status', changelog: 'https://fetchx.ai/changelog', docs: 'https://fetchx.ai/docs'},
  ...overrides,
});
const answered = (at: number, payload = operational()): Check => ({at, ok: true, http_status: 200, latency_ms: 120, error: null, payload});
const silent = (at: number, error = 'timeout'): Check => ({at, ok: false, http_status: null, latency_ms: null, error, payload: null});
const day = (date: string) => db.prepare('SELECT * FROM status_days WHERE day = ?').bind(date).first<Record<string, number>>();
const minute = (n: number) => T0 + n * 60;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db, (env as unknown as {TEST_MIGRATIONS: D1Migration[]}).TEST_MIGRATIONS);
});

describe('checkApi', () => {
  it('reads a status answer and keeps only the fields the page shows', async () => {
    const body = {...operational(), extra: 'ignored', notices: [{id: '7', kind: 'incident', title: 'Slow fetching', body: '', impact: 'minor',
      components: ['fetching'], pause_api: false, status: 'active', starts_at: '2026-11-21T09:00:00Z', ends_at: null, resolved_at: null,
      updates: [{at: '2026-11-21T09:05:00Z', text: 'Looking into it.'}], created_by: 'ops@example.com'}]};
    const check = await checkApi('https://api.test/v1/status', async () => Response.json(body), () => T0 * 1000);
    expect(check).toMatchObject({at: T0, ok: true, http_status: 200, error: null});
    expect(check.payload!.notices[0]).not.toHaveProperty('created_by');
    expect(check.payload).not.toHaveProperty('extra');
    expect(check.payload!.notices[0].updates).toEqual([{at: '2026-11-21T09:05:00.000Z', text: 'Looking into it.'}]);
  });

  it('counts anything else as no answer, without throwing', async () => {
    const at = () => T0 * 1000;
    expect(await checkApi('https://api.test/v1/status', async () => new Response('<html>502</html>', {status: 502}), at))
      .toMatchObject({ok: false, http_status: 502, error: 'http_502', payload: null});
    expect(await checkApi('https://api.test/v1/status', async () => Response.json({error: {code: 'maintenance'}}), at))
      .toMatchObject({ok: false, http_status: 200, error: 'invalid_body'});
    expect(await checkApi('https://api.test/v1/status', async () => { throw new TypeError('fetch failed'); }, at))
      .toMatchObject({ok: false, http_status: null, error: 'network'});
    expect(await checkApi('https://api.test/v1/status', async () => { throw new DOMException('slow', 'TimeoutError'); }, at))
      .toMatchObject({ok: false, error: 'timeout'});
  });

  it('refuses answers that are not a status', () => {
    expect(parseStatus({status: 'fine', components: []})).toBeNull();
    expect(parseStatus(null)).toBeNull();
    expect(parseStatus({status: 'degraded', components: [{id: 'api', status: 'degraded'}], links: {docs: 'javascript:alert(1)'}})!.links.docs)
      .toBe('https://fetchx.ai/docs');
  });
});

describe('recording checks', () => {
  it('treats one unanswered check as a blip and two in a row as an outage', async () => {
    await recordCheck(db, answered(minute(0)));
    await recordCheck(db, silent(minute(1)));
    expect(await day('2026-11-21')).toMatchObject({checks: 2, operational: 1, missed: 1, down: 0});
    let view = await publicStatus(db, minute(1) * 1000 + 5000);
    expect(view.status).toBe('operational');
    expect(view.monitor.failures).toBe(1);

    await recordCheck(db, silent(minute(2)));
    expect(await day('2026-11-21')).toMatchObject({checks: 3, operational: 1, missed: 0, down: 2});
    await recordCheck(db, silent(minute(3), 'http_502'));
    view = await publicStatus(db, minute(3) * 1000 + 5000);
    expect(view.status).toBe('major_outage');
    expect(view.components.every(component => component.status === 'major_outage')).toBe(true);
    expect(view.outages).toEqual([{started_at: new Date(minute(1) * 1000).toISOString(), ended_at: null, minutes: 2, ongoing: true}]);

    await recordCheck(db, answered(minute(4)));
    view = await publicStatus(db, minute(4) * 1000 + 5000);
    expect(view.status).toBe('operational');
    expect(view.outages[0]).toMatchObject({ended_at: new Date(minute(4) * 1000).toISOString(), minutes: 3, ongoing: false});
    expect(await day('2026-11-21')).toMatchObject({checks: 5, operational: 2, down: 3, missed: 0});
    const today = view.days.at(-1)!;
    expect(today).toMatchObject({date: '2026-11-21', checks: 5, down_minutes: 3, level: 'outage'});
    expect(today.uptime).toBeCloseTo(0.4);
    expect(view.days).toHaveLength(90);
    expect(view.days[0]).toMatchObject({date: '2026-08-24', checks: 0, uptime: null, level: 'no_data'});
    expect(view.uptime.days_90).toBeCloseTo(0.4);
  });

  it('counts what the API reports about itself', async () => {
    await recordCheck(db, answered(minute(0), operational({status: 'degraded'})));
    await recordCheck(db, answered(minute(1), operational({status: 'major_outage'})));
    await recordCheck(db, answered(minute(2), operational({status: 'maintenance'})));
    expect(await day('2026-11-21')).toMatchObject({checks: 3, degraded: 1, down: 1, maintenance: 1});
    expect((await publicStatus(db, minute(2) * 1000)).status).toBe('maintenance');
  });

  it('shows planned maintenance, not an outage, while a maintenance notice explains the silence', async () => {
    const notice = {id: '12', kind: 'maintenance' as const, title: 'Database upgrade', body: 'The API pauses for about 10 minutes.', impact: 'maintenance',
      components: ['api'], pause_api: true, status: 'active' as const, starts_at: new Date(minute(0) * 1000).toISOString(),
      ends_at: new Date(minute(10) * 1000).toISOString(), resolved_at: null, updates: []};
    await recordCheck(db, answered(minute(0), operational({status: 'maintenance', notices: [notice]})));
    await recordCheck(db, silent(minute(1), 'http_503'));
    await recordCheck(db, silent(minute(2), 'http_503'));
    expect(await day('2026-11-21')).toMatchObject({checks: 3, maintenance: 3, down: 0, missed: 0});
    const view = await publicStatus(db, minute(2) * 1000 + 1000);
    expect(view.status).toBe('maintenance');
    expect(view.outages).toEqual([]);
    expect(view.notices[0]).toMatchObject({id: '12', status: 'active', title: 'Database upgrade'});

    // Ten minutes past its planned end, silence is an outage again.
    await recordCheck(db, silent(minute(21)));
    await recordCheck(db, silent(minute(22)));
    expect((await publicStatus(db, minute(22) * 1000)).status).toBe('major_outage');
  });

  it('keeps notices after the API stops listing them, and moves scheduled ones to active on time', async () => {
    const scheduled = {id: '3', kind: 'maintenance' as const, title: 'Planned restart', body: '', impact: 'maintenance', components: ['api'],
      pause_api: true, status: 'scheduled' as const, starts_at: new Date(minute(30) * 1000).toISOString(), ends_at: null, resolved_at: null, updates: []};
    const resolved = {id: '2', kind: 'incident' as const, title: 'Errors on fetch', body: '', impact: 'minor', components: ['fetching'],
      pause_api: false, status: 'resolved' as const, starts_at: '2026-11-10T08:00:00.000Z', ends_at: null, resolved_at: '2026-11-10T09:00:00.000Z', updates: []};
    await recordCheck(db, answered(minute(0), operational({notices: [scheduled, resolved]})));
    await recordCheck(db, answered(minute(1), operational({notices: []})));
    let view = await publicStatus(db, minute(1) * 1000);
    expect(view.notices.map(notice => [notice.id, notice.status])).toEqual([['3', 'scheduled'], ['2', 'resolved']]);
    view = await publicStatus(db, minute(31) * 1000 - 1000);
    expect(view.status).toBe('unknown');
    await recordCheck(db, answered(minute(31), operational({notices: []})));
    view = await publicStatus(db, minute(31) * 1000);
    expect(view.notices.find(notice => notice.id === '3')!.status).toBe('active');
  });

  it('says unknown when the monitor has stopped, and before its first check', async () => {
    expect((await publicStatus(db, T0 * 1000)).status).toBe('unknown');
    await recordCheck(db, answered(minute(0)));
    expect((await publicStatus(db, minute(5) * 1000)).status).toBe('operational');
    const view = await publicStatus(db, minute(6) * 1000 + 1000);
    expect(view.status).toBe('unknown');
    expect(view.monitor.stale).toBe(true);
  });

  it('ignores a repeated check and purges old history once an hour', async () => {
    await db.prepare("INSERT INTO status_days (day, checks, operational) VALUES ('2026-08-01', 10, 10)").run();
    await db.prepare('INSERT INTO status_checks (checked_at, state) VALUES (?, ?)').bind(T0 - 8 * 86400, 'operational').run();
    await recordCheck(db, answered(minute(0)));
    await recordCheck(db, answered(minute(0)));
    expect(await day('2026-11-21')).toMatchObject({checks: 1});
    const hour = Date.UTC(2026, 10, 21, 11, 0, 0) / 1000;
    await recordCheck(db, answered(hour));
    expect(await day('2026-08-01')).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM status_checks WHERE checked_at < ?').bind(T0).first('n')).toBe(0);
  });
});

describe('GET /api/status', () => {
  it('answers JSON any site may read, and only to GET and HEAD', async () => {
    await recordCheck(db, answered(Math.floor(Date.now() / 1000)));
    const response = await handleStatus(new Request('https://fetchx.ai/api/status'), {DB: db});
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('public, max-age=30');
    const body = await response.json() as {status: string; days: unknown[]; api: {version: string}};
    expect(body).toMatchObject({status: 'operational', api: {version: '1.4.0'}});
    expect(body.days).toHaveLength(90);
    const head = await handleStatus(new Request('https://fetchx.ai/api/status', {method: 'HEAD'}), {DB: db});
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await handleStatus(new Request('https://fetchx.ai/api/status', {method: 'POST'}), {DB: db});
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('the monitor', () => {
  it('checks once and records the answer in every database', async () => {
    const calls: string[] = [];
    const result = await monitorStatus([db], 'https://api.test/v1/status', async input => { calls.push(String(input)); return Response.json(operational()); });
    expect(calls).toEqual(['https://api.test/v1/status']);
    expect(result).toMatchObject({ok: true, recorded: ['operational']});
    expect(await db.prepare('SELECT failures FROM status_snapshot').first('failures')).toBe(0);
  });
});
