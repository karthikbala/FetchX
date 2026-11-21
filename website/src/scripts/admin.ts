// Operator admin page. All data is rendered with textContent; nothing from the
// API is interpreted as HTML. Every write sends the session-bound CSRF token.
type Json = Record<string, any>;
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
let csrf = '';
let providers: string[] = [];

class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<Json> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrf; }
  const response = await fetch('/api/control' + path, { method, credentials: 'same-origin', headers, body: init.body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(init.body) });
  let payload: Json = {};
  try { payload = await response.json(); } catch { /* empty */ }
  if (!response.ok) throw new ApiError(response.status, payload?.error?.code ?? 'request_failed', payload?.error?.message ?? 'The request failed.');
  return payload;
}
function el(tag: string, props: Json = {}, ...children: (Node | string | null | undefined)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}
const cell = (...children: (Node | string | null)[]) => el('td', {}, ...children);
const tag = (text: string, kind = '') => el('span', { class: 'fx-admin-tag' + (kind ? ' ' + kind : ''), text });
const when = (value?: string | null) => (value ? new Date(value).toLocaleString() : '—');
const matchText = (match: Json) => (match?.host ? match.host : match?.hostSuffix ? '*' + match.hostSuffix : '—');
function toast(message: string) {
  const node = $('[data-admin-toast]')!; node.textContent = message; node.hidden = false;
  window.setTimeout(() => { node.hidden = true; }, 3500);
}
function showError(error: unknown) {
  const node = $('[data-admin-error]')!;
  node.textContent = error instanceof ApiError ? `${error.message} (${error.code})` : 'Something went wrong. Refresh and try again.';
  node.hidden = false;
}
const clearError = () => { $('[data-admin-error]')!.hidden = true; };
async function run(task: () => Promise<void>) { clearError(); try { await task(); } catch (error) { showError(error); } }

// ---- Rules ----
async function loadRules() {
  const data = await api('/admin/rules');
  providers = data.providers ?? providers;
  for (const select of $$<HTMLSelectElement>('[data-provider-select]')) {
    const current = select.value; select.replaceChildren(...providers.map(p => el('option', { value: p, text: p })));
    if (current) select.value = current;
  }
  const body = $('[data-rules-body]')!;
  body.replaceChildren(...(data.rules as Json[]).map(rule => {
    const enabled = rule.enabled !== false;
    const actions = el('div', {},
      el('button', { type: 'button', text: enabled ? 'Disable' : 'Enable', onclick: () => toggleRule(rule.id, !enabled) }),
      rule.source === 'database' ? el('button', { type: 'button', text: 'Edit', onclick: () => editRule(rule) }) : null,
      rule.source === 'database' ? el('button', { type: 'button', text: 'Delete', onclick: () => deleteRule(rule.id, rule.overrides) }) : null,
      el('button', { type: 'button', text: 'History', onclick: () => showRuleAudit(rule.id) }));
    return el('tr', {}, cell(rule.id), cell(rule.provider), cell(matchText(rule.match)), cell(rule.reason ?? ''),
      cell(tag(rule.source + (rule.overrides ? ` (overrides ${rule.overrides})` : ''))), cell(tag(enabled ? 'enabled' : 'disabled', enabled ? 'is-ok' : 'is-off')), cell(actions));
  }));
}
async function toggleRule(id: string, enable: boolean) {
  const reason = window.prompt(`${enable ? 'Enable' : 'Disable'} ${id}. Reason (recorded in the audit log):`);
  if (!reason) return;
  await run(async () => { await api(`/admin/rules/${encodeURIComponent(id)}/${enable ? 'enable' : 'disable'}`, { method: 'POST', body: { reason } }); toast(`${id} ${enable ? 'enabled' : 'disabled'}.`); await loadRules(); });
}
async function deleteRule(id: string, overrides: string | null) {
  if (!window.confirm(overrides ? `Delete ${id}? The ${overrides} rule with this id takes effect again.` : `Delete ${id}?`)) return;
  await run(async () => { await api(`/admin/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast(`${id} deleted.`); await loadRules(); });
}
function editRule(rule: Json) {
  const form = $<HTMLFormElement>('[data-rule-form]')!;
  (form.elements.namedItem('id') as HTMLInputElement).value = rule.id;
  (form.elements.namedItem('id') as HTMLInputElement).readOnly = true;
  (form.elements.namedItem('version') as HTMLInputElement).value = String(rule.version ?? '');
  (form.elements.namedItem('provider') as HTMLSelectElement).value = rule.provider;
  (form.elements.namedItem('matchType') as HTMLSelectElement).value = rule.match?.host ? 'host' : 'hostSuffix';
  (form.elements.namedItem('matchValue') as HTMLInputElement).value = rule.match?.host ?? rule.match?.hostSuffix ?? '';
  (form.elements.namedItem('reason') as HTMLInputElement).value = rule.reason ?? '';
  $('[data-rule-form-title]')!.textContent = `Edit ${rule.id}`; $('[data-rule-submit]')!.textContent = 'Save changes'; $('[data-rule-cancel]')!.hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function resetRuleForm() {
  const form = $<HTMLFormElement>('[data-rule-form]')!; form.reset();
  (form.elements.namedItem('id') as HTMLInputElement).readOnly = false;
  $('[data-rule-form-title]')!.textContent = 'Add a rule'; $('[data-rule-submit]')!.textContent = 'Add rule'; $('[data-rule-cancel]')!.hidden = true;
}
async function submitRule(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement, data = new FormData(form);
  const matchType = String(data.get('matchType')), value = String(data.get('matchValue')).trim().toLowerCase();
  const rule = { id: String(data.get('id')).trim(), provider: String(data.get('provider')), match: { [matchType]: matchType === 'hostSuffix' && !value.startsWith('.') ? '.' + value : value }, action: 'exclude', reason: String(data.get('reason')).trim() };
  const version = Number(data.get('version'));
  await run(async () => {
    if (version) await api(`/admin/rules/${encodeURIComponent(rule.id)}`, { method: 'PUT', body: { rule, version } });
    else await api('/admin/rules', { method: 'POST', body: { rule } });
    toast(version ? `${rule.id} saved.` : `${rule.id} added.`); resetRuleForm(); await loadRules();
  });
}
async function submitTest(event: SubmitEvent) {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement), out = $('[data-test-result]')!;
  await run(async () => {
    const result = await api('/admin/rules/test', { method: 'POST', body: { provider: String(data.get('provider')), host: String(data.get('host')).trim() } });
    out.textContent = result.excluded ? `${result.provider} is NOT used for ${result.host}: rule ${result.rule} — ${result.reason}` : `${result.provider} may be used for ${result.host} (no rule excludes it).`;
  });
}
async function showRuleAudit(id: string) {
  await run(async () => { const data = await api(`/admin/rules/${encodeURIComponent(id)}/audit`); renderAudit(data.entries); selectTab('audit'); });
}

// ---- Budgets ----
const GROUPS: [string, string][] = [['captcha', 'Captcha solving (2Captcha)'], ['residential', 'Residential proxies'], ['autoscaler', 'Browser worker VMs'],
  ['requests', 'Requests'], ['probes', 'Reachability probes'], ['accounts', 'Accounts']];
const CURRENCY: Record<string, string> = { usd_micro: '$', eur_micro: '€' };
const WINDOWS: Record<string, string> = { '24h': 'in 24 h', month: 'this month', total: 'in total' };
let budgetIndex = new Map<string, Json>();
// Money is held in millionths (micro-USD, micro-EUR); never through floats.
function microText(micro: number, grouping = true) {
  const whole = Math.floor(micro / 1_000_000);
  let fraction = String(micro % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  return `${grouping ? whole.toLocaleString('en-US') : whole}.${fraction}`;
}
function budgetText(budget: Json, value: number | null | undefined) {
  if (value === null || value === undefined) return budget.null_label ?? 'Not set';
  if (CURRENCY[budget.unit]) return CURRENCY[budget.unit] + microText(value);
  if (budget.unit === 'mb') return `${value.toLocaleString('en-US')} MB`;
  if (budget.unit === 'credits') return `${value.toLocaleString('en-US')} credits`;
  return value.toLocaleString('en-US');
}
function rangeText(budget: Json) {
  const plain = budget.unit === 'mb' || budget.unit === 'credits';
  const range = plain ? `${budget.min.toLocaleString('en-US')} to ${budgetText(budget, budget.max)}` : `${budgetText(budget, budget.min)} to ${budgetText(budget, budget.max)}`;
  return `Allowed ${range}${budget.nullable ? ', or ' + String(budget.null_label ?? 'none').toLowerCase() : ''}`;
}
function parseBudget(budget: Json, raw: string): number | null {
  const text = raw.trim().replace(/[$€,\s]/g, '');
  if (CURRENCY[budget.unit]) {
    const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text);
    if (!match) return null;
    const value = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'));
    return Number.isSafeInteger(value) ? value : null;
  }
  return /^\d{1,15}$/.test(text) ? Number(text) : null;
}
const sourceText = (source?: string) => source === 'database' ? 'set in portal' : source === 'config' ? 'config' : source === 'default' ? 'default' : source ?? '—';
function usedCell(budget: Json) {
  if (budget.used === null || budget.used === undefined) return cell('—');
  const share = typeof budget.value === 'number' && budget.value > 0 ? Math.round((budget.used / budget.value) * 100) : null;
  const label = budget.key === 'captcha.maxProjectDailyMicroUsd' ? 'busiest project, 24 h' : WINDOWS[budget.window] ?? '';
  const over = budget.value === 0 || (share !== null && share >= 100);
  return cell(el('span', { class: 'fx-admin-num', text: budgetText(budget, budget.used) }), el('small', { text: label }),
    share !== null || over ? tag(over ? 'used up' : `${share}%`, over ? 'is-off' : share! >= 80 ? 'is-warn' : 'is-ok') : null);
}
async function loadBudgets() {
  const data = await api('/admin/budgets');
  const budgets = data.budgets as Json[];
  budgetIndex = new Map(budgets.map(b => [b.key, b]));
  const a: Json | null = data.autoscaler ?? null;
  $('[data-autoscaler-status]')!.textContent = a
    ? `Autoscaler, reported ${when(a.received_at)}: worker VM budget ${'€' + microText(a.monthly_budget_micro_eur)} of a ${'€' + microText(a.monthly_budget_ceiling_micro_eur)} host ceiling, ${'€' + microText(a.committed_micro_eur)} committed in ${a.month_utc}; ${a.workers} of ${a.max_additional_workers} extra workers (host ceiling ${a.max_additional_workers_ceiling})${a.enabled ? '' : '; the autoscaler is disabled'}.`
    : 'The autoscaler has not reported to this gateway yet. It reports each time it reads the pool metrics, and never goes above the ceilings in its host config.';
  $('[data-budget-groups]')!.replaceChildren(...GROUPS.filter(([group]) => budgets.some(b => b.group === group)).map(([group, title]) =>
    el('div', { class: 'fx-admin-card' }, el('h2', { text: title }),
      el('div', { class: 'fx-admin-table-wrap' }, el('table', { class: 'fx-admin-table' },
        el('thead', {}, el('tr', {}, ...['Budget', 'Value', 'Used', 'Source', ''].map(h => el('th', { text: h })))),
        el('tbody', {}, ...budgets.filter(b => b.group === group).map(budget => el('tr', {},
          cell(el('strong', { text: budget.label }), el('small', { text: budget.description })),
          cell(el('span', { class: 'fx-admin-num', text: budgetText(budget, budget.value) }),
            budget.valid ? null : tag('not configured', 'is-off'),
            el('small', { text: rangeText(budget) })),
          usedCell(budget),
          cell(tag(sourceText(budget.source), budget.source === 'database' ? 'is-warn' : ''),
            budget.source === 'database' ? el('small', { text: `${budget.updated_by} · ${when(budget.updated_at)}${budget.reason ? ' · ' + budget.reason : ''}` }) : null,
            budget.source === 'database' ? el('small', { text: `Configured: ${budgetText(budget, budget.default)}` }) : null),
          cell(el('div', {},
            el('button', { type: 'button', text: 'Change', onclick: () => editBudget(budget) }),
            budget.source === 'database' ? el('button', { type: 'button', text: 'Reset', onclick: () => void resetBudget(budget) }) : null,
            el('button', { type: 'button', text: 'History', onclick: () => void showBudgetAudit(budget.key) })))))))))));
}
function editBudget(budget: Json) {
  const form = $<HTMLFormElement>('[data-budget-form]')!;
  form.hidden = false;
  (form.elements.namedItem('key') as HTMLInputElement).value = budget.key;
  (form.elements.namedItem('version') as HTMLInputElement).value = String(budget.version ?? 0);
  const input = form.elements.namedItem('value') as HTMLInputElement, none = form.elements.namedItem('none') as HTMLInputElement;
  input.value = budget.value === null ? '' : CURRENCY[budget.unit] ? microText(budget.value, false) : String(budget.value);
  none.checked = budget.value === null; input.disabled = none.checked;
  (form.elements.namedItem('reason') as HTMLInputElement).value = '';
  $('[data-budget-null]')!.hidden = !budget.nullable;
  $('[data-budget-null-label]')!.textContent = budget.null_label ?? 'No cap';
  $('[data-budget-value-label]')!.textContent = `New value${budget.unit === 'usd_micro' ? ' (USD)' : budget.unit === 'eur_micro' ? ' (EUR)' : budget.unit === 'mb' ? ' (MB)' : budget.unit === 'credits' ? ' (credits)' : ''}`;
  $('[data-budget-form-title]')!.textContent = budget.label;
  $('[data-budget-form-hint]')!.textContent = `Now ${budgetText(budget, budget.value)} (${sourceText(budget.source)}). ${rangeText(budget)}.`;
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  input.focus();
}
async function submitBudget(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement, data = new FormData(form);
  const key = String(data.get('key')), budget = budgetIndex.get(key);
  if (!budget) return;
  const value = data.get('none') === 'on' && budget.nullable ? null : parseBudget(budget, String(data.get('value') ?? ''));
  if (value === null && !(data.get('none') === 'on' && budget.nullable)) {
    showError(new ApiError(400, 'budget_value_invalid', `Enter ${CURRENCY[budget.unit] ? 'an amount with up to 6 decimals' : 'a whole number'}.`)); return;
  }
  if (value !== null && (value < budget.min || value > budget.max)) {
    showError(new ApiError(400, 'budget_value_invalid', `${rangeText(budget)}.`)); return;
  }
  await run(async () => {
    const result = await api(`/admin/budgets/${encodeURIComponent(key)}`, { method: 'PUT', body: { value, version: Number(data.get('version')), reason: String(data.get('reason')).trim() } });
    toast(`${budget.label}: ${budgetText(result.budget, result.budget.value)}.`); form.hidden = true; await loadBudgets();
  });
}
async function resetBudget(budget: Json) {
  const reason = window.prompt(`Reset "${budget.label}" to its configured value (${budgetText(budget, budget.default)}). Reason (recorded in the audit log):`);
  if (!reason) return;
  await run(async () => {
    await api(`/admin/budgets/${encodeURIComponent(budget.key)}/reset`, { method: 'POST', body: { version: budget.version, reason } });
    toast(`${budget.label} reset.`); await loadBudgets();
  });
}
async function showBudgetAudit(key: string) {
  await run(async () => { const data = await api(`/admin/budgets/${encodeURIComponent(key)}/audit`); renderAudit(data.entries); selectTab('audit'); });
}

// ---- Audit ----
function budgetChange(entry: Json) {
  const key = String(entry.rule_id).slice('budget:'.length), budget = budgetIndex.get(key) ?? { unit: 'count' };
  const side = (s: Json | null) => s ? `${budgetText(budget, s.value)} (${sourceText(s.source)})` : '—';
  return `${budget.label ?? key}: ${side(entry.before)} → ${side(entry.after)}${entry.note ? ' · ' + entry.note : ''}`;
}
function renderAudit(entries: Json[]) {
  $('[data-audit-body]')!.replaceChildren(...entries.map(entry => {
    const after = entry.after ?? {}, before = entry.before ?? {};
    const detail = String(entry.rule_id).startsWith('budget:') ? budgetChange(entry) :
      entry.action === 'delete' ? `was ${matchText(before.match)} (${before.provider})` :
      `${after.provider ?? ''} ${matchText(after.match)} ${after.enabled === false ? '· disabled' : ''}${after.note ? ' · ' + after.note : ''}`;
    return el('tr', {}, cell(when(entry.at)), cell(entry.rule_id), cell(tag(entry.action)), cell(entry.actor), cell(detail.trim()));
  }));
}
async function loadAudit() {
  if (!budgetIndex.size) await api('/admin/budgets').then(data => { budgetIndex = new Map((data.budgets as Json[]).map(b => [b.key, b])); }).catch(() => {});
  const data = await api('/admin/audit'); renderAudit(data.entries);
}

// ---- Probes ----
let pollTimer = 0;
async function loadProbes() {
  const data = await api('/admin/probes');
  $('[data-probes-body]')!.replaceChildren(...(data.probes as Json[]).map(probe => el('tr', {},
    cell(probe.host), cell((probe.countries ?? []).join(', ')),
    cell(tag(probe.state, probe.state === 'complete' ? 'is-ok' : probe.state === 'failed' || probe.state === 'interrupted' ? 'is-off' : '')),
    cell((probe.summary?.reachable_countries ?? []).join(', ') || '—'),
    cell(probe.summary?.recommended_route ? `${probe.summary.recommended_route.class} ${probe.summary.recommended_route.country} via ${probe.summary.recommended_route.provider} (${probe.summary.recommended_route.execution})` : '—'),
    cell(`${probe.requested_by} · ${when(probe.created_at)}${probe.applied_at ? ' · applied' : ''}`),
    cell(el('button', { type: 'button', text: 'View', onclick: () => showProbe(probe.id) })))));
  window.clearTimeout(pollTimer);
  if ((data.probes as Json[]).some(p => p.state === 'queued' || p.state === 'running')) pollTimer = window.setTimeout(() => void run(loadProbes), 3000);
}
async function submitProbe(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement, data = new FormData(form);
  const countries = data.getAll('country').map(String);
  await run(async () => {
    const result = await api('/admin/probes', { method: 'POST', body: { host: String(data.get('host')).trim(), countries, include_excluded: data.get('include_excluded') === 'on' } });
    toast(`Probe started for ${result.probe.host}.`); await loadProbes();
  });
}
async function showProbe(id: string) {
  await run(async () => {
    const { probe } = await api(`/admin/probes/${id}`);
    const box = $('[data-probe-detail]')!; box.hidden = false; box.dataset.probeId = id;
    $('[data-probe-title]')!.textContent = `Probe · ${probe.host} · ${probe.state}`;
    const cells: Json[] = probe.report?.cells ?? [];
    $('[data-cells-body]')!.replaceChildren(...cells.map(c => el('tr', {}, cell(c.country), cell(c.class), cell(c.provider),
      cell(tag(c.result + (c.rule ? ` (${c.rule})` : ''), c.result === 'ok' ? 'is-ok' : ['provider_refused', 'unreachable', 'denied', 'challenge', 'rate_limited'].includes(c.result) ? 'is-off' : '')),
      cell(String(c.connect_status ?? '—')), cell(c.tls ? 'yes' : '—'), cell(String(c.http_status ?? '—')), cell(String(c.bytes ?? '—')), cell(String(c.ms ?? '—')))));
    const s: Json = probe.report?.summary ?? {};
    const rows: [string, string][] = [
      ['Reachable countries', (s.reachable_countries ?? []).join(', ') || '—'], ['Unreachable countries', (s.unreachable_countries ?? []).join(', ') || '—'],
      ['Geo-restricted', s.geo_restricted ? 'yes' : 'no'], ['Providers refusing', (s.provider_refused ?? []).join(', ') || '—'],
      ['Datacenter blocked in', (s.datacenter_blocked_countries ?? []).join(', ') || '—'],
      ['Recommended route', s.recommended_route ? `${s.recommended_route.class} ${s.recommended_route.country} via ${s.recommended_route.provider} (${s.recommended_route.execution}${s.recommended_route.verified === false ? ', unverified' : ''})` : '—'],
      ['Error', probe.error ?? '—']];
    $('[data-probe-summary]')!.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
    const rules: Json[] = s.proposed_provider_rules ?? [];
    $('[data-apply-rules]')!.replaceChildren(...(rules.length ? rules.map(rule => el('label', { class: 'fx-admin-inline' },
      el('input', { type: 'checkbox', name: 'rule', value: rule.id }), `Add rule ${rule.id}: no ${rule.provider} for ${matchText(rule.match)}`)) : [el('p', { class: 'fx-admin-hint', text: 'No provider rules proposed.' })]));
    $<HTMLFormElement>('[data-apply-form]')!.hidden = probe.state !== 'complete';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
async function submitApply(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement, id = $('[data-probe-detail]')!.dataset.probeId!;
  const rules = new FormData(form).getAll('rule').map(String);
  if (!rules.length) { showError(new ApiError(400, 'probe_apply_empty', 'Select at least one proposed rule.')); return; }
  if (!window.confirm(`Add ${rules.length} provider rule(s)?`)) return;
  await run(async () => { await api(`/admin/probes/${id}/apply`, { method: 'POST', body: { rules } }); toast('Rules added.'); await Promise.all([loadRules(), loadProbes()]); });
}

// ---- Site knowledge ----
async function loadSites() {
  const { sites } = await api('/admin/sites');
  $('[data-sites-body]')!.replaceChildren(...(sites as Json[]).map(site => el('tr', {}, cell(site.host), cell(String(site.routes)),
    cell(String(site.proven ?? 0)), cell(String(site.cooling ?? 0)), cell(String(site.failing ?? 0)), cell(when(site.updated_at)),
    cell(el('button', { type: 'button', text: 'Routes', onclick: () => void run(() => showSite(site.host)) }),
      el('button', { type: 'button', text: 'Forget', onclick: () => void forgetSite(site.host) })))));
}
async function showSite(host: string) {
  const { routes } = await api(`/admin/sites/${encodeURIComponent(host)}`);
  const box = $('[data-site-detail]')!; box.hidden = false;
  $('[data-site-title]')!.textContent = `Routes · ${host}`;
  $('[data-site-routes]')!.replaceChildren(...(routes as Json[]).map(route => el('tr', {}, cell(route.execution), cell(route.proxy_class),
    cell(route.country ?? '—'), cell(route.provider ?? '—'), cell(tag(route.state, route.state === 'proven' ? 'is-ok' : ['cooling', 'failing'].includes(route.state) ? 'is-off' : '')),
    cell(String(route.successes)), cell(String(route.failures)), cell(route.last_outcome ?? '—'), cell(when(route.retry_not_before)))));
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function forgetSite(host: string) {
  if (!window.confirm(`Forget everything FetchX learned about ${host}? The next request starts from the cheapest route again.`)) return;
  await run(async () => { await api(`/admin/sites/${encodeURIComponent(host)}`, { method: 'DELETE' }); toast(`Forgot ${host}.`); $('[data-site-detail]')!.hidden = true; await loadSites(); });
}

// ---- Status notices ----
const COMPONENT_NAMES: Record<string, string> = { api: 'API', fetching: 'Fetching', console: 'Console and billing' };
const localInput = (value?: string | null) => {
  if (!value) return '';
  const date = new Date(value), pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromLocal = (value: string) => (value ? new Date(value).toISOString() : null);
async function loadNotices() {
  const { notices } = await api('/admin/notices');
  $('[data-notices-body]')!.replaceChildren(...(notices as Json[]).map(notice => {
    const state = notice.status === 'active' ? tag(notice.pause_api ? 'active · API paused' : 'active', notice.pause_api || notice.impact === 'major' ? 'is-off' : 'is-warn')
      : notice.status === 'scheduled' ? tag(notice.pause_api ? 'scheduled · will pause API' : 'scheduled') : tag('resolved', 'is-ok');
    const title = el('div', {}, el('strong', { text: notice.title }), el('small', { text: `${notice.kind === 'maintenance' ? 'Maintenance' : `Incident · ${notice.impact}`} · #${notice.id}` }));
    const latest = (notice.updates as Json[]).at(-1);
    if (latest) title.append(el('small', { text: `Latest: ${latest.text}` }));
    const span = el('div', {}, el('span', { text: when(notice.starts_at) }),
      el('small', { text: notice.resolved_at ? `resolved ${when(notice.resolved_at)}` : notice.ends_at ? `planned end ${when(notice.ends_at)}` : 'no planned end' }));
    const actions = notice.status === 'resolved' ? el('span', {}) : el('div', {},
      el('button', { type: 'button', text: 'Update', onclick: () => editNotice(notice) }),
      el('button', { type: 'button', text: 'Resolve', onclick: () => void resolveNotice(notice) }));
    return el('tr', {}, cell(title), cell(state), cell((notice.components as string[]).map(id => COMPONENT_NAMES[id] ?? id).join(', ') || '—'),
      cell(span), cell(el('div', {}, el('span', { text: notice.created_by }), notice.updated_by ? el('small', { text: `last: ${notice.updated_by}` }) : null)), cell(actions));
  }));
}
function syncNoticeKind() {
  const form = $<HTMLFormElement>('[data-notice-form]')!;
  const maintenance = (form.elements.namedItem('kind') as HTMLSelectElement).value === 'maintenance';
  $('[data-notice-impact]')!.hidden = maintenance;
  $('[data-notice-pause]')!.hidden = !maintenance;
  if (!maintenance) (form.elements.namedItem('pause_api') as HTMLInputElement).checked = false;
}
function resetNoticeForm() {
  const form = $<HTMLFormElement>('[data-notice-form]')!;
  form.reset();
  (form.elements.namedItem('id') as HTMLInputElement).value = '';
  (form.elements.namedItem('kind') as HTMLSelectElement).disabled = false;
  $('[data-notice-form-title]')!.textContent = 'Post a notice';
  $('[data-notice-submit]')!.textContent = 'Post notice';
  $('[data-notice-update-label]')!.textContent = 'First update';
  $('[data-notice-cancel]')!.hidden = true;
  syncNoticeKind();
}
function editNotice(notice: Json) {
  const form = $<HTMLFormElement>('[data-notice-form]')!;
  const field = <T extends HTMLElement = HTMLInputElement>(name: string) => form.elements.namedItem(name) as unknown as T;
  field('id').value = notice.id;
  field<HTMLSelectElement>('kind').value = notice.kind;
  field<HTMLSelectElement>('kind').disabled = true;
  field('title').value = notice.title;
  field<HTMLTextAreaElement>('body').value = notice.body ?? '';
  field<HTMLSelectElement>('impact').value = notice.kind === 'maintenance' ? 'minor' : notice.impact;
  for (const box of $$<HTMLInputElement>('input[name="components"]', form)) box.checked = (notice.components as string[]).includes(box.value);
  field('starts_at').value = localInput(notice.starts_at);
  field('ends_at').value = localInput(notice.ends_at);
  field('pause_api').checked = !!notice.pause_api;
  field('update').value = '';
  $('[data-notice-form-title]')!.textContent = `Update #${notice.id}`;
  $('[data-notice-submit]')!.textContent = 'Save';
  $('[data-notice-update-label]')!.textContent = 'Add an update (shown with the time)';
  $('[data-notice-cancel]')!.hidden = false;
  syncNoticeKind();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function submitNotice(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement, data = new FormData(form);
  const id = String(data.get('id') ?? ''), kind = (form.elements.namedItem('kind') as HTMLSelectElement).value;
  const startsAt = fromLocal(String(data.get('starts_at') ?? '')), endsAt = fromLocal(String(data.get('ends_at') ?? ''));
  const body: Json = {
    title: String(data.get('title') ?? '').trim(), body: String(data.get('body') ?? '').trim(),
    components: data.getAll('components').map(String), ends_at: endsAt,
  };
  if (kind === 'incident') body.impact = String(data.get('impact'));
  else body.pause_api = data.get('pause_api') === 'on';
  if (startsAt) body.starts_at = startsAt;
  const update = String(data.get('update') ?? '').trim();
  if (update) body.update = update;
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt ?? new Date().toISOString())) {
    showError(new ApiError(400, 'notice_ends_at_invalid', 'The planned end must be after the start.')); return;
  }
  if (body.pause_api && (!startsAt || Date.parse(startsAt) <= Date.now())
    && !window.confirm('This pauses the API now: every /v1 call except GET /v1/status will answer 503 maintenance until the notice ends or is resolved. Continue?')) return;
  await run(async () => {
    if (id) await api(`/admin/notices/${id}`, { method: 'PUT', body });
    else await api('/admin/notices', { method: 'POST', body: { kind, ...body } });
    toast(id ? `Notice #${id} updated.` : 'Notice posted.');
    resetNoticeForm();
    await loadNotices();
  });
}
async function resolveNotice(notice: Json) {
  const update = window.prompt(`Resolve “${notice.title}”${notice.pause_api ? ' and end the API pause' : ''}. Closing update shown on the status page:`, 'Resolved.');
  if (update === null) return;
  await run(async () => {
    await api(`/admin/notices/${notice.id}/resolve`, { method: 'POST', body: update.trim() ? { update: update.trim() } : {} });
    toast(`Notice #${notice.id} resolved.`); await loadNotices();
  });
}

// ---- Tabs and boot ----
const loaders: Record<string, () => Promise<void>> = { rules: loadRules, budgets: loadBudgets, probes: loadProbes, sites: loadSites, status: loadNotices, audit: loadAudit };
function selectTab(name: string) {
  for (const tab of $$('[data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of $$('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
}
async function boot() {
  const gate = $('[data-admin-gate-text]')!;
  try {
    const session = await api('/session'); csrf = session.csrf_token ?? '';
  } catch (error) {
    gate.textContent = error instanceof ApiError && error.status === 401 ? 'Sign in to continue.' : 'The account service is unavailable.';
    $('[data-admin-login]')!.hidden = !(error instanceof ApiError && error.status === 401); return;
  }
  try {
    const admin = await api('/admin/session'); $('[data-admin-who]')!.textContent = `Operator · ${admin.email}`;
  } catch (error) {
    gate.textContent = error instanceof ApiError && error.code === 'operator_required' ? 'This page is for FetchX operators. Your account does not have operator access.'
      : error instanceof ApiError && error.status === 404 ? 'Admin tools are not enabled on this service.' : 'Could not check operator access.';
    $('[data-admin-who]')!.textContent = ''; return;
  }
  $('[data-admin-gate]')!.hidden = true; $('[data-admin-content]')!.hidden = false;
  for (const tab of $$('[data-tab]')) tab.addEventListener('click', () => { selectTab(tab.dataset.tab!); void run(loaders[tab.dataset.tab!]); });
  $('[data-rule-form]')!.addEventListener('submit', event => void submitRule(event as SubmitEvent));
  $('[data-rule-cancel]')!.addEventListener('click', resetRuleForm);
  $('[data-test-form]')!.addEventListener('submit', event => void submitTest(event as SubmitEvent));
  $('[data-probe-form]')!.addEventListener('submit', event => void submitProbe(event as SubmitEvent));
  $('[data-apply-form]')!.addEventListener('submit', event => void submitApply(event as SubmitEvent));
  $('[data-budget-form]')!.addEventListener('submit', event => void submitBudget(event as SubmitEvent));
  $('[data-budget-cancel]')!.addEventListener('click', () => { $('[data-budget-form]')!.hidden = true; });
  $('[data-notice-form]')!.addEventListener('submit', event => void submitNotice(event as SubmitEvent));
  $('[data-notice-cancel]')!.addEventListener('click', resetNoticeForm);
  $('[data-notice-kind]')!.addEventListener('change', syncNoticeKind);
  syncNoticeKind();
  const none = $<HTMLInputElement>('[data-budget-form] input[name="none"]')!, value = $<HTMLInputElement>('[data-budget-form] input[name="value"]')!;
  none.addEventListener('change', () => { value.disabled = none.checked; });
  await run(loadRules);
}
void boot();
