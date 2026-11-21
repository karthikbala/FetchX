// /status: renders GET /api/status (the Cloudflare monitor's view) and refreshes it every minute.
type State = 'operational' | 'degraded' | 'partial_outage' | 'maintenance' | 'major_outage' | 'unknown';
type Notice = {
  id: string; kind: 'incident' | 'maintenance'; title: string; body: string; impact: string; components: string[]; pause_api: boolean;
  status: 'scheduled' | 'active' | 'resolved'; starts_at: string; ends_at: string | null; resolved_at: string | null; updates: { at: string; text: string }[];
};
type Status = {
  status: State; checked_at: string | null; answered_at: string | null; monitor: { failures: number; stale: boolean };
  components: { id: string; name: string; status: State }[]; notices: Notice[];
  outages: { started_at: string; ended_at: string | null; minutes: number; ongoing: boolean }[];
  days: { date: string; checks: number; uptime: number | null; down_minutes: number; level: string }[];
  uptime: { days_90: number | null }; api: { version: string | null };
};

const HEADLINES: Record<State, string> = {
  operational: 'All systems operational', degraded: 'Some systems are degraded', partial_outage: 'Partial outage',
  maintenance: 'Planned maintenance', major_outage: 'Major outage', unknown: 'Status unknown',
};
const WORDS: Record<State, string> = {
  operational: 'Operational', degraded: 'Degraded', partial_outage: 'Partial outage', maintenance: 'Maintenance',
  major_outage: 'Outage', unknown: 'Unknown',
};
const root = document.querySelector<HTMLElement>('[data-status-root]');
const $ = <T extends HTMLElement>(selector: string) => root!.querySelector<T>(selector)!;
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const at = (value: string) => when.format(new Date(value));

function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: (Node | string)[]) {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

function noticeState(notice: Notice): State {
  if (notice.kind === 'maintenance') return 'maintenance';
  return notice.impact === 'major' ? 'major_outage' : notice.impact === 'minor' ? 'degraded' : 'operational';
}

function noticeCard(notice: Notice) {
  const span = notice.status === 'scheduled' ? `Starts ${at(notice.starts_at)}${notice.ends_at ? ` · planned end ${at(notice.ends_at)}` : ''}`
    : notice.status === 'resolved' ? `${at(notice.starts_at)} to ${at(notice.resolved_at!)}`
    : `Since ${at(notice.starts_at)}${notice.ends_at ? ` · expected to end ${at(notice.ends_at)}` : ''}`;
  const meta = element('div', { className: 'st-notice-meta' },
    element('span', {}, notice.kind === 'maintenance' ? (notice.status === 'scheduled' ? 'Scheduled maintenance' : 'Maintenance') : 'Incident'),
    element('span', {}, span));
  if (notice.pause_api && notice.status !== 'resolved') meta.append(element('span', {}, 'The API answers 503 while this runs'));
  const card = element('article', { className: 'st-notice', dataset: { state: noticeState(notice) } }, element('h3', {}, notice.title), meta);
  if (notice.body) card.append(element('p', {}, notice.body));
  if (notice.updates.length) {
    card.append(element('ol', { className: 'st-updates' }, ...[...notice.updates].reverse().map(update =>
      element('li', {}, element('time', { dateTime: update.at }, at(update.at)), update.text))));
  }
  return card;
}

function render(status: Status) {
  const state = status.status;
  $('[data-status-dot]').dataset.state = state;
  $('[data-status-headline]').textContent = HEADLINES[state];
  const summary = state === 'major_outage' && status.monitor.failures >= 2
    ? `The API has not answered the last ${status.monitor.failures} checks${status.answered_at ? `, since ${at(status.answered_at)}` : ''}. Requests may fail; retry later with the same idempotency_key.`
    : state === 'maintenance' ? 'Planned maintenance is under way. Requests that get a 503 maintenance answer were not run or charged; retry after the Retry-After wait.'
    : state === 'unknown' ? (status.checked_at ? 'The monitor has not reported for a few minutes, so the state shown may be out of date.' : 'The monitor has not reported yet.')
    : state === 'operational' ? 'The API and fetching are working normally.'
    : 'Part of FetchX is not working normally. Details are below.';
  $('[data-status-summary]').textContent = summary;
  $('[data-status-checked]').textContent = status.checked_at
    ? `Last checked ${at(status.checked_at)}${status.api.version ? ` · API ${status.api.version}` : ''}` : '';

  const open = status.notices.filter(notice => notice.status !== 'resolved');
  $('[data-status-notices]').hidden = !open.length;
  $('[data-status-notice-list]').replaceChildren(...open.map(noticeCard));

  $('[data-status-components]').replaceChildren(...status.components.map(component =>
    element('li', {}, element('span', {}, component.name), element('span', { className: 'st-chip', dataset: { state: component.status } }, WORDS[component.status] ?? component.status))));

  const since = status.days.find(day => day.level !== 'no_data');
  $('[data-status-uptime]').textContent = status.uptime.days_90 == null || !since ? 'No data yet'
    : `${(Math.floor(status.uptime.days_90 * 10000) / 100).toFixed(2)}% uptime${since === status.days[0] ? '' : ` since ${dayLabel.format(new Date(`${since.date}T00:00:00Z`))}`}`;
  $('[data-status-days]').replaceChildren(...status.days.map(day => {
    const date = dayLabel.format(new Date(`${day.date}T00:00:00Z`));
    const detail = day.level === 'no_data' ? 'no data'
      : `${(Math.floor((day.uptime ?? 0) * 10000) / 100).toFixed(2)}% up${day.down_minutes ? `, about ${day.down_minutes} min down` : ''}${day.level === 'maintenance' ? ', maintenance' : day.level === 'degraded' ? ', degraded' : ''}`;
    return element('li', { title: `${date}: ${detail}`, ariaLabel: `${date}: ${detail}`, tabIndex: -1, dataset: { level: day.level } });
  }));

  const history: { start: number; node: HTMLElement }[] = status.notices.filter(notice => notice.status === 'resolved')
    .map(notice => ({ start: Date.parse(notice.starts_at), node: noticeCard(notice) }));
  for (const outage of status.outages) {
    const card = element('article', { className: 'st-notice', dataset: { state: 'major_outage' } },
      element('h3', {}, outage.ongoing ? 'The API is not answering' : 'The API did not answer'),
      element('div', { className: 'st-notice-meta' }, element('span', {}, 'Seen by the monitor'),
        element('span', {}, outage.ongoing ? `Since ${at(outage.started_at)}` : `${at(outage.started_at)} to ${at(outage.ended_at!)} · about ${outage.minutes} min`)));
    history.push({ start: Date.parse(outage.started_at), node: card });
  }
  history.sort((a, b) => b.start - a.start);
  $('[data-status-history]').replaceChildren(...(history.length ? history.map(item => item.node) : [element('p', { className: 'st-empty' }, 'Nothing in the last 90 days.')]));
  root!.setAttribute('aria-busy', 'false');
}

async function load() {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch('/api/status', { cache: 'no-store', credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error(String(response.status));
    const status = await response.json() as Status;
    if (!(status.status in HEADLINES) || !Array.isArray(status.days)) throw new Error('shape');
    render(status);
  } catch {
    $('[data-status-headline]').textContent = HEADLINES.unknown;
    $('[data-status-summary]').textContent = 'This page could not load the monitor’s data. Refresh in a minute, or check the API directly at app.fetchx.ai/v1/status.';
    root!.setAttribute('aria-busy', 'false');
  } finally { clearTimeout(timer); }
}

if (root) {
  void load();
  setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
}

export {};
