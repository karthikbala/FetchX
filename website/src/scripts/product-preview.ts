// The workspace uses the same-origin control plane. Only project IDs and pending
// operation keys cross page boundaries; credentials and source inputs stay in memory.
import { mountGoogleSignIn } from './google-sign-in';
type Json = Record<string, any>;
type Project = { id: string; name: string; status: string; created_at?: string };
type Profile = { id: string; version: number; origins: string[]; paths?: string[]; methods: string[]; proxy_classes: string[]; countries: string[]; route_reservations?: Json[] };
class ControlError extends Error {
  constructor(message: string, public code: string, public status = 0, public payload: Json | null = null) { super(message); }
}
const root = document.querySelector<HTMLElement>('[data-product-preview]');
if (root) void initWorkspace(root);

async function initWorkspace(root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(selector: string, parent: ParentNode = root) => parent.querySelector<T>(selector);
  const qa = <T extends HTMLElement = HTMLElement>(selector: string, parent: ParentNode = root) => [...parent.querySelectorAll<T>(selector)];
  const authPage = ['signup', 'login'].includes(root.dataset.view || '');
  const selectedStorage = 'fetchx-selected-project';
  const pendingPrefix = 'fetchx-pending-operations:';
  const validProject = (id: unknown): id is string => typeof id === 'string' && /^cp_[a-f0-9-]{36}$/i.test(id);
  const validOperation = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(key);
  let csrf = '', projects: Project[] = [], project: Project | null = null, profiles: Profile[] = [], capabilities: Json = {};
  let service: Json = {}, keys: Json[] = [], operations: Json[] = [], usage: Json | null = null, billing: Json | null = null;
  let challenge = '', email = '', revealedSecret = '', currentKey = '', currentResult: Json | null = null;
  let signingOut = false;
  let signedIn = false, ready = false, sending = false, prepared = true, loadVersion = 0, mutating = 0;
  let toastTimer: ReturnType<typeof setTimeout>;
  let confirmCallback: (() => void) | null = null;
  let lastFocus: HTMLElement | null = null;
  let disposeGoogle: (() => void) | undefined;
  try { sessionStorage.removeItem('fetchx-product-preview-v1'); } catch { /* Clear obsolete preview state when storage is available. */ }

  function textAll(selector: string, value: unknown) { qa(selector).forEach(node => { node.textContent = String(value ?? '—'); }); }
  function setError(error: unknown, selector = '[data-page-error]') {
    const message = error instanceof Error ? error.message : String(error || 'The request could not be completed.');
    const node = q(selector); if (node) { node.textContent = message.slice(0, 1000); node.hidden = !message; }
  }
  function clearError(selector = '[data-page-error]') { const node = q(selector); if (node) { node.textContent = ''; node.hidden = true; } }
  function toast(message: string) { const node = q('[data-toast]'); if (!node) return; clearTimeout(toastTimer); node.textContent = message; node.hidden = false; toastTimer = setTimeout(() => { node.hidden = true; }, 5000); }
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', value = '') => { const node = document.createElement(tag); node.className = className; node.textContent = value; return node; };
  function selectedId() { try { const id = sessionStorage.getItem(selectedStorage); return validProject(id) ? id : ''; } catch { return ''; } }
  function saveProject(id: string) { try { sessionStorage.setItem(selectedStorage, id); } catch { /* A project can be used without a stored preference. */ } }
  function pendingKeys(id = project?.id): string[] {
    if (!id || !validProject(id)) return [];
    try { const value = JSON.parse(sessionStorage.getItem(pendingPrefix + id) || '[]'); return Array.isArray(value) ? value.filter(validOperation).slice(-100) : []; } catch { return []; }
  }
  function savePending(key: string) {
    if (!project) throw new ControlError('Select a project first.', 'project_required');
    const pending = pendingKeys();
    if (!pending.includes(key)) pending.push(key);
    if (pending.length > 100) throw new ControlError('Recover pending operations before creating more requests.', 'pending_limit');
    try {
      sessionStorage.setItem(pendingPrefix + project.id, JSON.stringify(pending));
      if (!pendingKeys().includes(key)) throw new Error('Storage verification failed');
    } catch { throw new ControlError('Browser session storage is unavailable. Enable it so the operation key can be retained before sending.', 'recovery_storage_unavailable'); }
  }
  function clearPending(key: string) { if (!project) return; try { const remaining = pendingKeys().filter(item => item !== key); if (remaining.length) sessionStorage.setItem(pendingPrefix + project.id, JSON.stringify(remaining)); else sessionStorage.removeItem(pendingPrefix + project.id); } catch { /* A retained key is safe to recover again. */ } }

  async function api(path: string, options: { method?: string; body?: Json; publicFetch?: boolean; timeout?: number } = {}): Promise<Json> {
    const method = options.method || 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout ?? 20000);
    try {
      const response = await fetch('/api/control' + path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
      let body: Json;
      try { body = await response.json(); } catch { throw new ControlError('The control service returned an unreadable response. Check service configuration and recover any pending request.', 'invalid_response', response.status); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ControlError('The control service returned an invalid response.', 'invalid_response', response.status);
      if (path === '/status' && body.enabled === false) return body;
      if (options.publicFetch && typeof body.state === 'string') return body;
      if (!response.ok) throw new ControlError(body.error?.message || 'The control service could not complete this action.', body.error?.code || 'control_error', response.status, body);
      return body;
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError(controller.signal.aborted ? 'The request timed out. Recover the saved operation before considering new source work.' : 'Unable to reach the control service. Check the connection and service configuration.', controller.signal.aborted ? 'timeout' : 'network_error');
    } finally { clearTimeout(timer); }
  }
  async function busy(form: HTMLFormElement, action: () => Promise<void>, errorSelector = '[data-page-error]') {
    if (form.dataset.busy) return;
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')];
    const disabled = controls.map(control => control.disabled);
    mutating++;
    form.dataset.busy = 'true'; form.setAttribute('aria-busy', 'true'); controls.forEach(control => { control.disabled = true; }); updateRunButton(); clearError(errorSelector);
    try { await action(); } catch (error) { setError(error, errorSelector); }
    finally { mutating--; delete form.dataset.busy; form.removeAttribute('aria-busy'); controls.forEach((control, index) => { control.disabled = disabled[index]; }); updateRunButton(); }
  }
  function onForm(selector: string, action: (form: HTMLFormElement, values: FormData) => Promise<void>, errorSelector?: string) {
    q<HTMLFormElement>(selector)?.addEventListener('submit', event => { event.preventDefault(); if (authPage && mutating) return; const form = event.currentTarget as HTMLFormElement; const values = new FormData(form); void busy(form, () => action(form, values), errorSelector); });
  }
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); toast('Copied to clipboard.'); } catch { toast('Clipboard unavailable. Select and copy the visible text.'); } }
  function concealSecret() { revealedSecret = ''; textAll('[data-key-secret],[data-signup-secret]', 'Concealed'); }
  function showSecret(token: unknown) {
    concealSecret();
    if (typeof token !== 'string' || !/^fxk_[A-Za-z0-9_-]+$/.test(token)) throw new ControlError('The key was created, but its secret was not returned. Create or rotate a replacement.', 'key_secret_unavailable');
    revealedSecret = token;
    if (authPage) {
      textAll('[data-signup-secret]', token); q('[data-signup-reveal]')!.hidden = false; q('[data-signup-key]')!.hidden = true; q('[data-finish-signup]')!.hidden = false;
    } else { textAll('[data-key-secret]', token); lastFocus = document.activeElement as HTMLElement; q<HTMLDialogElement>('[data-key-dialog]')?.showModal(); }
  }
  function confirmAction(title: string, description: string, action: string, callback: () => void) {
    lastFocus = document.activeElement as HTMLElement; textAll('#confirm-title', title); textAll('[data-confirm-description]', description); textAll('[data-confirm-action]', action); confirmCallback = callback; q<HTMLDialogElement>('[data-confirm-dialog]')?.showModal();
  }
  q<HTMLDialogElement>('[data-confirm-dialog]')?.addEventListener('close', event => { const dialog = event.currentTarget as HTMLDialogElement; const callback = confirmCallback; confirmCallback = null; if (dialog.returnValue === 'confirm') callback?.(); else lastFocus?.focus(); dialog.returnValue = ''; });
  function stage(index: number) { qa('[data-signup-stage]').forEach(node => { node.hidden = Number(node.dataset.signupStage) !== index; }); qa('[data-signup-progress]').forEach(node => { node.classList.toggle('is-current', Number(node.dataset.signupProgress) === index); node.classList.toggle('is-complete', Number(node.dataset.signupProgress) < index); }); q(`[data-signup-stage="${index}"] input`)?.focus(); }
  function scopes(values: FormData) { const selected = values.getAll('scope').map(String); if (!selected.length) throw new ControlError('Select at least one key permission.', 'scopes_required'); return selected; }
  function acceptSession(data: Json) { csrf = String(data.csrf_token || ''); projects = Array.isArray(data.projects) ? data.projects : []; signedIn = true; textAll('[data-user-email]', data.user?.email || 'Verified account'); qa('[data-logout],[data-session-account]').forEach(node => { node.hidden = false; }); }
  function finishSignIn(data: Json) {
    disposeGoogle?.(); disposeGoogle = undefined;
    acceptSession(data); email = ''; challenge = ''; clearError();
    const code = q<HTMLInputElement>('[data-signup-verify] input'); if (code) code.value = '';
    if (projects.length) window.location.assign('/app'); else stage(2);
  }
  async function googleRequest(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (path !== '/auth/google/verify') return api(path, { method: 'POST', body });
    if (mutating || signedIn) throw new ControlError('A sign-in is already in progress. Continue with your current sign-in.', 'auth_in_progress');
    const controls = qa<HTMLInputElement | HTMLButtonElement>('[data-signup-email] input,[data-signup-email] button,[data-signup-verify] input,[data-signup-verify] button,[data-resend-code],[data-change-email]');
    const disabled = controls.map(control => control.disabled);
    mutating++; controls.forEach(control => { control.disabled = true; });
    try { return await api(path, { method: 'POST', body }); }
    finally { mutating--; controls.forEach((control, index) => { control.disabled = disabled[index]; }); }
  }
  function setProjectOptions() {
    const select = q<HTMLSelectElement>('[data-project-select]'); if (!select) return; select.replaceChildren();
    if (!projects.length) select.append(new Option('No projects yet', ''));
    projects.forEach(item => select.append(new Option(item.name, item.id))); select.disabled = !projects.length;
    if (project) select.value = project.id;
    qa<HTMLButtonElement>('[data-open-project]').forEach(button => { button.disabled = !signedIn; });
  }
  function gate(title: string, description: string, action: 'login' | 'project' | '' = '') {
    q('[data-workspace-content]')?.setAttribute('hidden', ''); q('[data-workspace-gate]')?.removeAttribute('hidden'); textAll('[data-gate-title]', title); textAll('[data-gate-description]', description);
    const login = q('[data-login-link]'); if (login) login.hidden = action !== 'login';
    const create = q('[data-workspace-gate] [data-open-project]'); if (create) create.hidden = action !== 'project';
  }
  function projectPath(path = '') { if (!project) throw new ControlError('Select a project first.', 'project_required'); return '/projects/' + encodeURIComponent(project.id) + path; }

  onForm('[data-signup-email]', async (_form, values) => {
    email = String(values.get('email') || '').trim();
    const data = await api('/auth/code', { method: 'POST', body: { email } });
    challenge = data.challenge_id; if (!challenge) throw new ControlError('The verification challenge was not returned.', 'invalid_response');
    textAll('[data-verification-help]', service.mail_delivery === 'local_private_mailbox' ? 'Local review mode: no email is sent. Use the eight-digit code from the private local test mailbox.' : `If delivery succeeds, use the eight-digit code sent to ${email}.`); stage(1);
  });
  onForm('[data-signup-verify]', async (_form, values) => {
    const data = await api('/auth/verify', { method: 'POST', body: { email, challenge_id: challenge, code: String(values.get('code') || '') } });
    finishSignIn(data);
  });
  q('[data-resend-code]')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true; clearError();
    try { const data = await api('/auth/code', { method: 'POST', body: { email } }); challenge = data.challenge_id; toast(service.mail_delivery === 'local_private_mailbox' ? 'Local review mode: find the new code in the private local test mailbox. No email was sent.' : 'If delivery succeeds, use the new code from your email.'); } catch (error) { setError(error); } finally { button.disabled = false; }
  });
  q('[data-change-email]')?.addEventListener('click', () => { challenge = ''; clearError(); stage(0); });
  onForm('[data-signup-project]', async (_form, values) => {
    const data = await api('/projects', { method: 'POST', body: { name: String(values.get('project') || '').trim() } });
    project = data.project; if (!project || !validProject(project.id)) throw new ControlError('The service did not return the created project.', 'invalid_response');
    saveProject(project.id); textAll('[data-project-name]', project.name); stage(3);
  });
  onForm('[data-signup-key]', async (_form, values) => {
    const data = await api(projectPath('/keys'), { method: 'POST', body: { name: String(values.get('name') || '').trim(), scopes: scopes(values) } }); showSecret(data.token);
  });
  q('[data-signup-copy]')?.addEventListener('click', () => { if (revealedSecret) void copy(revealedSecret); });
  q('[data-conceal-signup-key]')?.addEventListener('click', () => { concealSecret(); q<HTMLButtonElement>('[data-signup-copy]')!.disabled = true; });
  qa('[data-logout]').forEach(button => button.addEventListener('click', async () => {
    if (signingOut) return;
    signingOut = true; clearError();
    const buttons = qa<HTMLButtonElement>('[data-logout]');
    buttons.forEach(node => { node.disabled = true; node.textContent = 'Signing out…'; node.setAttribute('aria-busy', 'true'); });
    try { await api('/auth/logout', { method: 'POST', body: {} }); concealSecret(); csrf = ''; signedIn = false; try { sessionStorage.removeItem(selectedStorage); } catch {} window.location.assign('/login'); }
    catch (error) {
      setError(error); signingOut = false;
      buttons.forEach(node => { node.disabled = false; node.textContent = 'Sign out'; node.removeAttribute('aria-busy'); });
    }
  }));
  qa('[data-open-project]').forEach(button => button.addEventListener('click', () => { if (!signedIn) return; lastFocus = document.activeElement as HTMLElement; q<HTMLDialogElement>('[data-project-dialog]')?.showModal(); q<HTMLInputElement>('[data-create-project] input')?.focus(); }));
  q('[data-close-project]')?.addEventListener('click', () => q<HTMLDialogElement>('[data-project-dialog]')?.close());
  onForm('[data-create-project]', async (form, values) => { const data = await api('/projects', { method: 'POST', body: { name: String(values.get('name') || '').trim() } }); projects.push(data.project); setProjectOptions(); q<HTMLDialogElement>('[data-project-dialog]')?.close(); form.reset(); await selectProject(data.project.id, true); }, '[data-project-error]');
  q<HTMLSelectElement>('[data-project-select]')?.addEventListener('change', event => { const id = (event.currentTarget as HTMLSelectElement).value; void selectProject(id); });
  onForm('[data-create-key]', async (form, values) => { const data = await api(projectPath('/keys'), { method: 'POST', body: { name: String(values.get('name') || '').trim(), scopes: scopes(values) } }); showSecret(data.token); form.reset(); await refreshKeys(); });
  q('[data-copy-key]')?.addEventListener('click', () => { if (revealedSecret) void copy(revealedSecret); });
  q('[data-close-key]')?.addEventListener('click', () => { concealSecret(); q<HTMLDialogElement>('[data-key-dialog]')?.close(); });
  q<HTMLDialogElement>('[data-key-dialog]')?.addEventListener('close', () => { concealSecret(); lastFocus?.focus(); });
  q<HTMLDialogElement>('[data-key-dialog]')?.addEventListener('cancel', concealSecret);
  q('[data-close-request]')?.addEventListener('click', () => q<HTMLDialogElement>('[data-request-dialog]')?.close());
  q<HTMLDialogElement>('[data-request-dialog]')?.addEventListener('close', () => { textAll('[data-request-detail]', ''); lastFocus?.focus(); });

  async function selectProject(id: string, created = false) {
    const selected = projects.find(item => item.id === id); if (!selected) return;
    if (sending || (mutating && !created)) { toast('Wait for the active action before switching projects.'); const select = q<HTMLSelectElement>('[data-project-select]'); if (select && project) select.value = project.id; return; }
    const version = ++loadVersion; project = selected; ready = false; concealSecret(); q<HTMLDialogElement>('[data-key-dialog]')?.close(); q<HTMLDialogElement>('[data-request-dialog]')?.close(); saveProject(id); setProjectOptions(); clearError(); gate('Loading project…', 'Reading approved profiles, keys, history, and current balances.'); textAll('[data-project-name]', selected.name);
    const result = await Promise.allSettled([api(projectPath()), api(projectPath('/keys')), api(projectPath('/requests')), api(projectPath('/usage')), api(projectPath('/billing'))]);
    if (version !== loadVersion) return;
    const detail = result[0];
    if (detail.status !== 'fulfilled') { gate('Project unavailable', 'The service could not load this project. Refresh to try reading it again.'); setError(detail.reason); return; }
    project = detail.value.project; profiles = Array.isArray(detail.value.access_profiles) ? detail.value.access_profiles : []; capabilities = detail.value.capabilities || {};
    keys = result[1].status === 'fulfilled' ? result[1].value.keys || [] : [];
    operations = result[2].status === 'fulfilled' ? result[2].value.operations || [] : [];
    usage = result[3].status === 'fulfilled' ? result[3].value : null;
    billing = result[4].status === 'fulfilled' ? result[4].value : null;
    const failures = result.slice(1).filter(item => item.status === 'rejected');
    if (failures.length) setError('Some project data could not be loaded. ' + failures.map(item => item.status === 'rejected' ? item.reason.message : '').join(' '));
    ready = true; prepared = true; currentResult = null; currentKey = pendingKeys().at(-1) || ''; if (currentKey) prepared = false;
    renderProfiles(); renderKeys(); renderRequests(); renderUsage(); renderChecklist(); renderRecovery(); renderResult(null);
    q('[data-workspace-gate]')!.hidden = true; q('[data-workspace-content]')!.hidden = false; updateRunButton();
  }
  async function refreshKeys() { const id = project?.id; const data = await api(projectPath('/keys')); if (id !== project?.id) return; keys = data.keys || []; renderKeys(); renderChecklist(); }
  async function refreshHistory() { const id = project?.id; const data = await api(projectPath('/requests')); if (id !== project?.id) return; operations = data.operations || []; renderRequests(); renderChecklist(); }
  async function refreshAccounting() { const id = project?.id; const results = await Promise.allSettled([api(projectPath('/usage')), api(projectPath('/billing')), refreshHistory()]); if (id !== project?.id) return; usage = results[0].status === 'fulfilled' ? results[0].value : null; billing = results[1].status === 'fulfilled' ? results[1].value : null; renderUsage(); if (results.some(result => result.status === 'rejected')) setError('The request result is shown, but some usage or history data could not be refreshed. Use Refresh to read it again.'); }
  function renderKeys() {
    const parent = q('[data-key-list]'); if (!parent) return; parent.replaceChildren();
    if (!keys.length) { parent.append(element('p', 'pp-live-empty', 'No keys returned. Create a scoped API key for your server.')); return; }
    keys.forEach(key => {
      const row = element('div', 'pp-key-row'); row.dataset.keyId = key.id;
      const identity = element('div', 'pp-key-identity'); identity.append(element('strong', '', key.name || 'API key'), element('code', '', key.id), element('small', '', `Created ${date(key.created_at)} · ${(key.scopes || []).join(', ')}`)); row.append(identity);
      const revoked = Boolean(key.revoked_at); row.append(element('span', 'pp-status ' + (revoked ? 'pp-status-failed' : 'pp-status-completed'), revoked ? 'Revoked' : 'Active'));
      if (!revoked) {
        const actions = element('div', 'pp-key-actions');
        for (const action of ['rotate', 'revoke']) {
          const button = element('button', 'pp-button pp-button-secondary', action === 'rotate' ? 'Rotate' : 'Revoke'); button.type = 'button'; button.dataset[action + 'Key'] = key.id;
          button.addEventListener('click', () => confirmAction(action === 'rotate' ? 'Rotate this API key?' : 'Revoke this API key?', action === 'rotate' ? 'The old key stops authenticating immediately. Save the replacement secret when it appears.' : 'This key stops authenticating immediately. Applications using it will need another active key.', action === 'rotate' ? 'Rotate key' : 'Revoke key', () => { void (async () => { button.disabled = true; mutating++; updateRunButton(); clearError(); try { const data = await api(projectPath('/keys/' + encodeURIComponent(key.id) + (action === 'rotate' ? '/rotate' : '')), { method: action === 'rotate' ? 'POST' : 'DELETE', ...(action === 'rotate' ? { body: {} } : {}) }); if (action === 'rotate') showSecret(data.token); await refreshKeys(); } catch (error) { setError(error); button.disabled = false; } finally { mutating--; updateRunButton(); } })(); })); actions.append(button);
        }
        row.append(actions);
      }
      parent.append(row);
    });
  }
  function renderUsage() {
    const credits = usage?.credits, gateway = usage?.gateway, outcomes = gateway?.outcomes;
    const total = Array.isArray(gateway?.by_key_and_state) ? gateway.by_key_and_state.reduce((sum: number, row: Json) => sum + (Number(row.operations) || 0), 0) : null;
    textAll('[data-credits-available]', number(credits?.available)); textAll('[data-credits-granted]', credits ? `${number(credits.granted)} credits allocated` : 'Balance unavailable');
    textAll('[data-credits-used]', number(credits?.settled)); textAll('[data-reserved-credits]', credits ? number(credits.reserved + credits.held) : '—'); textAll('[data-credit-fraction]', credits ? `${number(credits.available)} available` : 'Unavailable');
    for (const field of ['reserved', 'held', 'released']) textAll(`[data-credits-${field}]`, number(credits?.[field]));
    textAll('[data-request-count]', number(total));
    for (const [selector, field] of [['source-successes', 'source_successes'], ['source-failures', 'source_failures'], ['gateway-failures', 'gateway_failures'], ['unknown-outcomes', 'unknown']]) textAll(`[data-${selector}]`, number(outcomes?.[field]));
    const latency = gateway?.latency_ms; textAll('[data-mean-latency]', typeof latency?.mean === 'number' ? `${number(Math.round(latency.mean))} ms` : 'Unavailable'); textAll('[data-p95-latency]', typeof latency?.p95 === 'number' ? `${number(Math.round(latency.p95))} ms` : 'Unavailable');
    qa('[data-credit-meter]').forEach(node => { node.style.width = credits?.granted > 0 ? `${Math.max(0, Math.min(100, (credits.settled + credits.reserved + credits.held) / credits.granted * 100))}%` : '0%'; });
    const status = billing?.status; textAll('[data-billing-status]', status === 'trial' ? 'Trial access' : status === 'approval_required' ? 'Approval required' : 'Status unavailable'); textAll('[data-billing-description]', status === 'trial' ? 'Your configured trial allocation is active. Usage is limited to approved native HTTP routes.' : status === 'approval_required' ? 'Contact FetchX for a reviewed credit grant or commercial access.' : 'The service did not return a billing status. Refresh to read it again.');
  }
  function renderChecklist() { const states = [signedIn, Boolean(project), keys.some(key => !key.revoked_at), operations.length > 0]; textAll('[data-onboarding-count]', `${states.filter(Boolean).length} of 4 complete`); ['email','project','key','request'].forEach((name, index) => { const node = q(`[data-checklist-${name}]`); node?.classList.toggle('is-complete', states[index]); const mark = node?.querySelector('.pp-step-check'); if (mark) mark.textContent = states[index] ? '✓' : String(index + 1); }); }
  function renderRequests() {
    const search = q<HTMLInputElement>('[data-request-search]')?.value.trim().toLowerCase() || '', filter = q<HTMLSelectElement>('[data-request-filter]')?.value || 'all';
    const filtered = operations.filter(item => (filter === 'all' || item.state === filter) && String(item.id).toLowerCase().includes(search)); textAll('[data-filter-count]', `${filtered.length} retained operations`);
    qa('[data-request-list]').forEach(parent => {
      parent.replaceChildren(); const rows = filtered.slice(0, Number(parent.dataset.requestLimit) || 100);
      if (!rows.length) { const empty = element('div', 'pp-log-empty'); empty.append(element('h3', '', search || filter !== 'all' ? 'No matching operations.' : 'No retained requests.'), element('p', '', 'Send an approved request in the playground to start your project history.')); parent.append(empty); return; }
      const scroll = element('div', 'pp-table-scroll'), table = element('table', 'pp-request-table'), head = element('thead'), header = element('tr'); ['Operation', 'State', 'Route / profile', 'Latency', 'Created'].forEach(value => { const th = element('th', '', value); th.scope = 'col'; header.append(th); }); head.append(header); table.append(head); const body = element('tbody');
      rows.forEach(item => {
        const row = element('tr'), id = element('td'), link = element('button', 'pp-request-link', item.id); link.type = 'button'; link.dataset.requestId = item.id; link.addEventListener('click', () => { void openRequest(item.id); }); id.append(link); row.append(id);
        const stateCell = element('td'), state = String(item.state || 'unknown'); stateCell.append(element('span', 'pp-status pp-status-' + (['completed','failed','running','unknown'].includes(state) ? state : 'running'), state)); row.append(stateCell);
        const route = item.routing || item.route || {}, profile = item.access_profile || item.profile || {};
        row.append(element('td', '', `${route.class || item.proxy_class || '—'}${route.country ? ' / ' + route.country : ''} · ${typeof profile === 'string' ? profile : profile.id || '—'}`), element('td', '', typeof item.latency_ms === 'number' ? `${number(Math.round(item.latency_ms))} ms` : '—'), element('td', '', date(item.created_at))); body.append(row);
      }); table.append(body); scroll.append(table); parent.append(scroll);
    });
  }
  function previewResult(result: Json) {
    // Never insert remote HTML, even for text/html; omit bulky binary data and
    // cap text before serializing the response inspector.
    const data = result.data ? { ...result.data, body_base64: result.data.body_base64 ? `[${result.data.body_base64.length} base64 characters omitted]` : null, text: typeof result.data.text === 'string' ? result.data.text.slice(0, 32000) + (result.data.text.length > 32000 ? '\n[Source text truncated at 32,000 characters]' : '') : null } : null;
    return JSON.stringify({ ...result, data }, null, 2).slice(0, 60000);
  }
  async function openRequest(id: string) {
    const originalProject = project?.id; lastFocus = document.activeElement as HTMLElement; const dialog = q<HTMLDialogElement>('[data-request-dialog]'); if (!dialog) return; textAll('[data-request-detail]', 'Loading retained response…'); textAll('[data-request-detail-status]', 'Read-only lookup. No source request is dispatched.'); dialog.showModal();
    try { const result = await api(projectPath('/requests/' + encodeURIComponent(id)), { publicFetch: true }); if (originalProject !== project?.id || !dialog.open) return; textAll('[data-request-detail]', previewResult(result)); textAll('[data-request-detail-status]', `State: ${result.state}. Application acceptance: ${result.application_acceptance || 'not evaluated'}.`); } catch (error) { if (dialog.open) textAll('[data-request-detail]', error instanceof Error ? error.message : String(error)); }
  }
  q('[data-request-search]')?.addEventListener('input', renderRequests); q('[data-request-filter]')?.addEventListener('change', renderRequests);
  q('[data-refresh-history]')?.addEventListener('click', async event => { const button = event.currentTarget as HTMLButtonElement; button.disabled = true; clearError(); try { await refreshHistory(); } catch (error) { setError(error); } finally { button.disabled = false; } });

  function selectedProfile() { const value = q<HTMLSelectElement>('[data-request-profile]')?.value; return profiles.find(item => `${item.id}@${item.version}` === value); }
  function renderProfiles() {
    const select = q<HTMLSelectElement>('[data-request-profile]'); if (!select) return; select.replaceChildren();
    profiles.forEach(profile => select.append(new Option(`${profile.id} · v${profile.version}`, `${profile.id}@${profile.version}`)));
    select.disabled = !profiles.length; if (!profiles.length) { select.append(new Option('No approved HTTP profiles', '')); setError('This project has no approved native HTTP access profile. Contact FetchX to configure access.', '[data-fetch-error]'); }
    updateRoutes();
  }
  function updateRoutes() {
    const profile = selectedProfile(), route = q<HTMLSelectElement>('[data-request-route]'); if (!route) return;
    const previous = route.value; route.replaceChildren();
    const allowed: string[] = Array.isArray(capabilities.routes) ? capabilities.routes : ['direct'];
    for (const value of profile?.proxy_classes || []) if (allowed.includes(value)) route.append(new Option(value === 'direct' ? 'Direct · country unverified' : value === 'datacenter' ? 'Datacenter' : value, value));
    if ([...route.options].some(option => option.value === previous)) route.value = previous;
    route.disabled = !route.options.length;
    textAll('[data-profile-summary]', profile ? `Approved origins: ${profile.origins.join(', ')}${profile.paths?.length ? ' · Paths: ' + profile.paths.join(', ') : ''}` : 'No profile configured.');
    const method = q<HTMLSelectElement>('[data-request-method]'); if (method) { const old = method.value; method.replaceChildren(); for (const value of profile?.methods || []) if (['GET','HEAD'].includes(value)) method.append(new Option(value, value)); method.disabled = !method.options.length; if ([...method.options].some(option => option.value === old)) method.value = old; }
    updateCountries();
  }
  function updateCountries() {
    const profile = selectedProfile(), route = q<HTMLSelectElement>('[data-request-route]')?.value, country = q<HTMLSelectElement>('[data-request-country]'); if (!country) return; const previous = country.value; country.replaceChildren();
    if (route === 'direct') { country.append(new Option('Unverified · null', '')); country.disabled = true; }
    else { (profile?.countries || []).forEach(value => country.append(new Option(value, value))); country.disabled = !country.options.length; if ([...country.options].some(option => option.value === previous)) country.value = previous; }
    updateRunButton(); renderCode();
  }
  function updateRunButton() {
    q<HTMLSelectElement>('[data-project-select]')?.toggleAttribute('disabled', sending || mutating > 0 || !projects.length);
    const button = q<HTMLButtonElement>('[data-run-request]'); if (!button) return;
    const profile = selectedProfile(), route = q<HTMLSelectElement>('[data-request-route]')?.value, method = q<HTMLSelectElement>('[data-request-method]')?.value;
    button.disabled = !ready || sending || !prepared || !profile || !route || !method;
    button.textContent = sending ? 'Waiting for response…' : !prepared ? 'Start a new request to send again' : 'Send request →';
    const fresh = q<HTMLButtonElement>('[data-new-request]'); if (fresh) fresh.disabled = sending || !ready;
    const recover = q<HTMLButtonElement>('[data-recover-result]'); if (recover) recover.disabled = sending || !currentKey;
  }
  function renderRecovery() {
    const pending = pendingKeys(), select = q<HTMLSelectElement>('[data-pending-operation]'); if (select) { select.replaceChildren(); pending.forEach(key => select.append(new Option(key, key))); select.value = currentKey; }
    const label = q('[data-pending-label]'); if (label) label.hidden = pending.length < 2;
    const recover = q('[data-recover-result]'); if (recover) recover.hidden = !currentKey;
    const note = q('[data-recovery-note]'); if (note) note.hidden = !pending.length;
    textAll('[data-operation-key]', currentKey || 'Assigned before dispatch'); updateRunButton(); renderCode();
  }
  function renderResult(result: Json | null) {
    currentResult = result;
    const state = result?.state || (currentKey ? 'Pending recovery' : 'Ready'); textAll('[data-response-state]', state[0].toUpperCase() + state.slice(1));
    const badge = q('[data-response-state]'); if (badge) badge.className = 'pp-status pp-status-' + (['completed','failed','running','unknown'].includes(state) ? state : 'running');
    textAll('[data-response-output]', result ? previewResult(result) : currentKey ? 'A saved operation key is awaiting recovery. Select “Recover saved result” to read retained state.' : 'Send a request to inspect the retained response.');
    textAll('[data-response-diagnostics]', result ? JSON.stringify({ routing: result.routing, diagnostics: result.diagnostics, usage: result.usage, retry: result.retry, error: result.error }, null, 2).slice(0, 48000) : 'No diagnostics yet.');
    textAll('[data-response-note]', result ? `${result.success ? 'Source response retained.' : result.error?.message || 'Operation state retained.'} Application acceptance: ${result.application_acceptance || 'not evaluated'}.` : currentKey ? 'Recovery never redispatches the source request.' : 'No request has been sent.');
    renderRecovery();
  }
  function fetchBody(): Json {
    const profile = selectedProfile(); if (!profile) throw new ControlError('Select an approved access profile.', 'profile_required');
    const proxyClass = q<HTMLSelectElement>('[data-request-route]')?.value || '', country = proxyClass === 'direct' ? null : q<HTMLSelectElement>('[data-request-country]')?.value;
    return { idempotency_key: currentKey || 'REPLACE_WITH_NEW_OPERATION_KEY', access_profile: { id: profile.id, version: profile.version }, url: q<HTMLInputElement>('[data-request-url]')?.value || '', method: q<HTMLSelectElement>('[data-request-method]')?.value || 'GET', proxy: { class: proxyClass, country } };
  }
  function newRequest() {
    prepared = true; currentKey = ''; clearError('[data-fetch-error]'); renderResult(null); q<HTMLInputElement>('[data-request-url]')?.focus();
  }
  q('[data-new-request]')?.addEventListener('click', () => {
    if (pendingKeys().length) confirmAction('Start a deliberate new request?', 'Pending operations and their reservations remain unchanged. This request uses a new operation key and may consume additional credits. You can still recover saved pending keys.', 'Start new request', newRequest);
    else newRequest();
  });
  q<HTMLSelectElement>('[data-pending-operation]')?.addEventListener('change', event => { currentKey = (event.currentTarget as HTMLSelectElement).value; prepared = false; renderResult(null); });
  onForm('[data-playground-form]', async () => {
    if (!ready || !prepared || sending) return;
    currentKey = 'console_' + crypto.randomUUID();
    const body = fetchBody();
    savePending(currentKey); // A storage failure prevents dispatch.
    prepared = false; sending = true; renderRecovery(); textAll('[data-response-state]', 'Running'); textAll('[data-response-note]', 'Request dispatched. Keep the operation key for read-only recovery.'); textAll('[data-response-output]', 'Waiting for the gateway response…');
    try {
      const result = await api(projectPath('/fetch'), { method: 'POST', body, publicFetch: true, timeout: 45000 });
      if (['completed','failed','rejected'].includes(result.state)) clearPending(currentKey);
      renderResult(result);
    } catch (error) {
      renderResult({ state: 'unknown', success: false, idempotency_key: currentKey, error: { code: error instanceof ControlError ? error.code : 'network_error', message: error instanceof Error ? error.message : 'The operation outcome is unknown.' }, application_acceptance: 'not_evaluated' }); setError(error, '[data-fetch-error]');
    } finally { sending = false; renderRecovery(); await refreshAccounting(); }
  }, '[data-fetch-error]');
  q('[data-recover-result]')?.addEventListener('click', async () => {
    if (!currentKey || sending) return; sending = true; updateRunButton(); clearError('[data-fetch-error]');
    try { const result = await api(projectPath('/fetch/' + encodeURIComponent(currentKey)), { publicFetch: true }); if (result.operation_id && ['completed','failed'].includes(result.state)) clearPending(currentKey); renderResult(result); }
    catch (error) { setError(error, '[data-fetch-error]'); textAll('[data-response-note]', 'Recovery could not confirm an outcome. The original key remains saved; no source work was resubmitted.'); }
    finally { sending = false; renderRecovery(); await refreshAccounting(); }
  });
  function renderCode() {
    if (!q('[data-generated-code]')) return;
    const profile = selectedProfile(); if (!profile) { textAll('[data-generated-code]', 'No approved native HTTP profile is available.'); return; }
    const body = currentResult && !prepared ? null : fetchBody(), recovery = !prepared && currentKey;
    const method = recovery ? 'GET' : 'POST', endpoint = String(service.api_base_url || 'https://YOUR_FETCHX_API').replace(/\/$/, '') + '/v2/fetch' + (recovery ? '/' + encodeURIComponent(currentKey) : '');
    const language = q<HTMLSelectElement>('[data-code-language]')?.value || 'curl'; let code = '';
    if (language === 'javascript') code = `const response = await fetch(${JSON.stringify(endpoint)}, {\n  method: ${JSON.stringify(method)},\n  headers: { Authorization: \`Bearer \${process.env.FETCHX_API_KEY}\`${recovery ? '' : ', "Content-Type": "application/json"'} }${recovery ? '' : ',\n  body: JSON.stringify(' + JSON.stringify(body, null, 2) + ')'}\n});\nconst result = await response.json();\nconsole.log(result);`;
    else if (language === 'python') code = `import os, json, requests\n${recovery ? '' : 'payload = json.loads(' + JSON.stringify(JSON.stringify(body)) + ')\n'}response = requests.${recovery ? 'get' : 'post'}(\n    ${JSON.stringify(endpoint)},\n    headers={"Authorization": "Bearer " + os.environ["FETCHX_API_KEY"]}${recovery ? '' : ',\n    json=payload'}\n)\nprint(response.json())`;
    else { const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"; code = `curl ${quote(endpoint)} \\\n  -H "Authorization: Bearer $FETCHX_API_KEY"${recovery ? '' : ' \\\n  -H "Content-Type: application/json" \\\n  --data ' + quote(JSON.stringify(body, null, 2))}`; }
    textAll('[data-generated-code]', code);
  }
  q('[data-request-profile]')?.addEventListener('change', updateRoutes); q('[data-request-route]')?.addEventListener('change', updateCountries); q('[data-request-country]')?.addEventListener('change', renderCode); q('[data-request-method]')?.addEventListener('change', renderCode); q('[data-request-url]')?.addEventListener('input', renderCode); q('[data-code-language]')?.addEventListener('change', renderCode); q('[data-copy-code]')?.addEventListener('click', () => { void copy(q('[data-generated-code]')?.textContent || ''); });
  const tabs = qa<HTMLButtonElement>('[data-inspector-tab]');
  function selectTab(button: HTMLButtonElement) { tabs.forEach(tab => { const selected = tab === button; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }); qa('[data-inspector-panel]').forEach(panel => { panel.hidden = panel.dataset.inspectorPanel !== button.dataset.inspectorTab; }); }
  tabs.forEach((tab, index) => { tab.addEventListener('click', () => selectTab(tab)); tab.addEventListener('keydown', event => { let next = index; if (event.key === 'ArrowRight') next = (index + 1) % tabs.length; else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = tabs.length - 1; else return; event.preventDefault(); selectTab(tabs[next]); tabs[next].focus(); }); });
  const menu = q<HTMLButtonElement>('[data-app-menu]');
  function closeMenu() { root.classList.remove('pp-menu-open'); menu?.setAttribute('aria-expanded', 'false'); menu?.setAttribute('aria-label', 'Open workspace navigation'); }
  menu?.addEventListener('click', () => { const open = menu.getAttribute('aria-expanded') !== 'true'; root.classList.toggle('pp-menu-open', open); menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? 'Close workspace navigation' : 'Open workspace navigation'); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && root.classList.contains('pp-menu-open')) { closeMenu(); menu?.focus(); } });
  document.addEventListener('click', event => { if (root.classList.contains('pp-menu-open') && !(event.target as Element).closest('.pp-sidebar,[data-app-menu]')) closeMenu(); });
  window.addEventListener('pagehide', () => { disposeGoogle?.(); concealSecret(); csrf = ''; email = ''; challenge = ''; currentResult = null; textAll('[data-response-output],[data-response-diagnostics],[data-request-detail],[data-generated-code]', ''); });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  q('[data-refresh-workspace]')?.addEventListener('click', () => { if (!sending && !mutating) void start(); });

  async function start() {
    disposeGoogle?.(); disposeGoogle = undefined;
    ready = false; signedIn = false; csrf = ''; projects = []; project = null; concealSecret(); clearError();
    qa('[data-logout],[data-session-account]').forEach(node => { node.hidden = true; }); setProjectOptions();
    textAll('[data-user-email]', 'Not signed in');
    if (!authPage) gate('Opening your workspace…', 'Checking the service and your session.');
    try {
      service = await api('/status');
      if (!service.enabled) throw new ControlError('Self-service access is not configured on this service. Contact FetchX for access.', 'service_unavailable');
      textAll('[data-service-status]', service.mail_delivery === 'local_private_mailbox' ? 'Local review · private test mailbox' : service.mail_configured || service.google?.enabled ? 'Connected to the control service' : 'Sign-in is not configured');
      textAll('[data-auth-delivery-help]', service.mail_delivery === 'local_private_mailbox' ? 'Local review mode uses a private test mailbox. No email is sent.' : 'We’ll email a one-time code to verify your address.');
      let session: Json | null = null;
      try { session = await api('/session'); } catch (error) { if (!(error instanceof ControlError) || error.status !== 401) throw error; }
      if (session) {
        acceptSession(session);
        if (authPage) {
          if (projects.length) { qa('[data-signup-stage]').forEach(node => { node.hidden = true; }); q('[data-auth-existing]')!.hidden = false; q('[data-auth-progress]')?.setAttribute('hidden', ''); }
          else stage(2);
        } else { setProjectOptions(); if (projects.length) await selectProject(projects.some(item => item.id === selectedId()) ? selectedId() : projects[0].id); else gate('Create your first project.', 'Your email is verified. Create a project to receive its configured access and allocation.', 'project'); }
      } else if (authPage) {
        const google = service.google;
        if (!service.mail_configured && !google?.enabled) throw new ControlError('Sign-in is not configured. Contact FetchX to enable account access.', 'auth_unconfigured');
        q<HTMLButtonElement>('[data-signup-email] button')!.disabled = !service.mail_configured;
        if (!service.mail_configured) textAll('[data-auth-delivery-help]', 'Email codes are unavailable right now. Continue with Google to sign in.');
        const googleContainer = q('[data-google-signin]');
        if (google?.enabled === true && typeof google.client_id === 'string' && googleContainer) disposeGoogle = mountGoogleSignIn({ container: googleContainer, clientId: google.client_id, request: googleRequest, onSession: finishSignIn });
      } else { signedIn = false; setProjectOptions(); gate('Sign in to continue.', 'Use Google or a one-time email code to access your projects.', 'login'); }
    } catch (error) {
      textAll('[data-service-status]', 'Service unavailable'); setError(error);
      if (!authPage) gate('Workspace unavailable.', 'The configured control service could not be reached. No account, request, or credit data has been simulated.');
    }
  }
  await start();
}
