// Operator admin page. All data is rendered with textContent; nothing from the
// API is interpreted as HTML. Every write sends the session-bound CSRF token.
type Json = Record<string, any>;
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
let csrf = '';
let providers: string[] = [];
let profilesCache: Json[] = [];
const FIELD_HELP: Record<string, string> = {
  country: 'Two-letter country (e.g. US)', routingPolicy: 'legacy or residential-v1', execution: 'http or browser',
  browserEngine: 'camoufox or cloakbrowser', browserEngineFallback: 'cloakbrowser (Camoufox profiles only)',
  maxRouteAttempts: '1–6', maxSessionRenewals: '0–10',
};
const NUMERIC = new Set(['maxRouteAttempts', 'maxSessionRenewals']);

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

// ---- Audit ----
function renderAudit(entries: Json[]) {
  $('[data-audit-body]')!.replaceChildren(...entries.map(entry => {
    const after = entry.after ?? {}, before = entry.before ?? {};
    const detail = entry.action === 'delete' ? `was ${matchText(before.match)} (${before.provider})` :
      `${after.provider ?? ''} ${matchText(after.match)} ${after.enabled === false ? '· disabled' : ''}${after.note ? ' · ' + after.note : ''}`;
    return el('tr', {}, cell(when(entry.at)), cell(entry.rule_id), cell(tag(entry.action)), cell(entry.actor), cell(detail.trim()));
  }));
}
async function loadAudit() { const data = await api('/admin/audit'); renderAudit(data.entries); }

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
      ['Proposed v1 routing', s.proposed_profile?.v1 ? JSON.stringify(s.proposed_profile.v1) : '—'],
      ['Error', probe.error ?? '—']];
    $('[data-probe-summary]')!.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
    const rules: Json[] = s.proposed_provider_rules ?? [];
    $('[data-apply-rules]')!.replaceChildren(...(rules.length ? rules.map(rule => el('label', { class: 'fx-admin-inline' },
      el('input', { type: 'checkbox', name: 'rule', value: rule.id }), `Add rule ${rule.id}: no ${rule.provider} for ${matchText(rule.match)}`)) : [el('p', { class: 'fx-admin-hint', text: 'No provider rules proposed.' })]));
    const select = $<HTMLSelectElement>('[data-apply-profile]')!;
    if (!profilesCache.length) profilesCache = (await api('/admin/profiles')).profiles;
    select.replaceChildren(el('option', { value: '', text: '— none —' }), ...profilesCache.map(p => el('option', { value: p.id, text: p.id })));
    select.disabled = !s.proposed_profile?.v1;
    $<HTMLFormElement>('[data-apply-form]')!.hidden = probe.state !== 'complete';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
async function submitApply(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement, data = new FormData(form), id = $('[data-probe-detail]')!.dataset.probeId!;
  const rules = data.getAll('rule').map(String), profileId = String(data.get('profile') ?? '');
  const body: Json = { rules };
  if (profileId) { const current = profilesCache.find(p => p.id === profileId); body.profile = { id: profileId, ...(current?.version ? { version: current.version } : {}) }; }
  if (!window.confirm(`Apply ${rules.length} rule(s)${profileId ? ` and the proposed routing to ${profileId}` : ''}?`)) return;
  await run(async () => { await api(`/admin/probes/${id}/apply`, { method: 'POST', body }); toast('Proposal applied.'); profilesCache = []; await Promise.all([loadRules(), loadProbes(), loadProfiles()]); });
}

// ---- Profiles ----
async function loadProfiles() {
  const data = await api('/admin/profiles'); profilesCache = data.profiles;
  const fmt = (o: Json | null) => (o && Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ') : '—');
  $('[data-profiles-body]')!.replaceChildren(...profilesCache.map(p => el('tr', {}, cell(p.id), cell((p.hosts ?? []).join(', ')),
    cell(fmt(p.resolved ?? p.effective)), cell(p.override ? `${fmt(p.override)} · v${p.version} · ${p.updated_by}` : '—'),
    cell(el('button', { type: 'button', text: 'Edit routing', onclick: () => editProfile(p) })))));
}
function editProfile(profile: Json) {
  const form = $<HTMLFormElement>('[data-profile-form]')!; form.hidden = false; form.dataset.profile = profile.id; form.dataset.version = String(profile.version ?? '');
  $('[data-profile-form-title]')!.textContent = `Edit routing · ${profile.id}`;
  const fields = Object.keys(FIELD_HELP);
  $('[data-profile-fields]')!.replaceChildren(...fields.map(name => el('label', {}, `${name} (${FIELD_HELP[name]})`,
    el('input', { name, value: profile.override?.[name] ?? '', placeholder: profile.effective?.[name] !== undefined ? `current: ${profile.effective[name]}` : 'not set' }))));
  ($('[data-profile-reset]') as HTMLButtonElement).disabled = !profile.override;
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function submitProfile(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement, data = new FormData(form), patch: Json = {};
  for (const [name, raw] of data.entries()) { const value = String(raw).trim(); if (value) patch[name] = NUMERIC.has(name) ? Number(value) : value; }
  if (!Object.keys(patch).length) { showError(new ApiError(400, 'profile_override_empty', 'Set at least one field, or use Remove override.')); return; }
  const version = Number(form.dataset.version) || null;
  await run(async () => { await api(`/admin/profiles/${encodeURIComponent(form.dataset.profile!)}/routing`, { method: 'PUT', body: { patch, version } }); toast('Override saved.'); form.hidden = true; await loadProfiles(); });
}
async function resetProfile() {
  const form = $<HTMLFormElement>('[data-profile-form]')!, id = form.dataset.profile!;
  if (!window.confirm(`Remove the routing override for ${id}? New workflows use its base settings again.`)) return;
  await run(async () => { await api(`/admin/profiles/${encodeURIComponent(id)}/routing`, { method: 'DELETE' }); toast('Override removed.'); form.hidden = true; await loadProfiles(); });
}

// ---- Tabs and boot ----
const loaders: Record<string, () => Promise<void>> = { rules: loadRules, probes: loadProbes, profiles: loadProfiles, audit: loadAudit };
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
  $('[data-profile-form]')!.addEventListener('submit', event => void submitProfile(event as SubmitEvent));
  $('[data-profile-reset]')!.addEventListener('click', () => void resetProfile());
  $('[data-profile-cancel]')!.addEventListener('click', () => { $('[data-profile-form]')!.hidden = true; });
  await run(loadRules);
}
void boot();
