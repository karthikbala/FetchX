// The workspace uses the same-origin control plane. Only project IDs and pending
// operation keys cross page boundaries; credentials and source inputs stay in memory.
import { mountGoogleSignIn } from './google-sign-in';
import { consumeGithubResult, mountGithubSignIn } from './github-sign-in';
import { countries, countryName } from '../data/countries';
import { operationExecution, operationResource, requestCode, routeClasses, routeLabels, type Execution, type PlaygroundCapabilities, type Preparation, type RouteClass, type SafeKey } from '../data/playground';
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
  let signedIn = false, ready = false, sending = false, draftOpen = true, loadVersion = 0, mutating = 0;
  let toastTimer: ReturnType<typeof setTimeout>;
  let confirmCallback: (() => void) | null = null;
  let lastFocus: HTMLElement | null = null;
  let disposeGoogle: (() => void) | undefined;
  let disposeGithub: (() => void) | undefined;
  let githubInProgress = false;
  let leavingPage = false;
  let githubControls: { control: HTMLInputElement | HTMLButtonElement; disabled: boolean }[] = [];
  const githubResult = authPage ? consumeGithubResult() : null;
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
  function savePending(id: string, key: string) {
    const pending = pendingKeys(id);
    if (!pending.includes(key)) pending.push(key);
    if (pending.length > 100) throw new ControlError('Recover pending operations before creating more requests.', 'pending_limit');
    try {
      sessionStorage.setItem(pendingPrefix + id, JSON.stringify(pending));
      if (!pendingKeys(id).includes(key)) throw new Error('Storage verification failed');
    } catch { throw new ControlError('Browser session storage is unavailable. Enable it so the operation key can be retained before sending.', 'recovery_storage_unavailable'); }
  }
  function clearPending(id: string, key: string) { try { const remaining = pendingKeys(id).filter(item => item !== key); if (remaining.length) sessionStorage.setItem(pendingPrefix + id, JSON.stringify(remaining)); else sessionStorage.removeItem(pendingPrefix + id); } catch { /* A retained key is safe to recover again. */ } }

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
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select'), ...(authPage ? qa<HTMLButtonElement>('[data-github-start],[data-github-connect]') : [])];
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
  function acceptSession(data: Json) { csrf = String(data.csrf_token || ''); projects = Array.isArray(data.projects) ? data.projects : []; signedIn = true; textAll('[data-user-email]', data.user?.email || 'Verified account'); qa('[data-logout],[data-session-account],[data-auth-account]').forEach(node => { node.hidden = false; });
    const account = q('[data-github-account]');
    const connected = data.auth_methods?.github === true;
    if (authPage && account && (service.github?.enabled === true || connected)) {
      account.hidden = false;
      q('[data-github-connected]')!.hidden = !connected; q('[data-github-connect]')!.hidden = connected;
      disposeGithub?.(); disposeGithub = connected ? undefined : mountGithubSignIn({ container: account, mode: 'link', request: githubRequest, setBusy: setGithubBusy });
    }
  }
  function finishSignIn(data: Json) {
    disposeGoogle?.(); disposeGoogle = undefined;
    disposeGithub?.(); disposeGithub = undefined;
    acceptSession(data); email = ''; challenge = ''; clearError();
    const code = q<HTMLInputElement>('[data-signup-verify] input'); if (code) code.value = '';
    if (projects.length && githubResult?.connectRequired) { showExistingAccount(); toast('Signed in. Choose Connect GitHub to connect this account.'); requestAnimationFrame(() => q('[data-github-connect]')?.focus()); }
    else if (projects.length) window.location.assign('/app'); else stage(2);
  }
  function showExistingAccount() { qa('[data-signup-stage]').forEach(node => { node.hidden = true; }); q('[data-auth-existing]')!.hidden = false; q('[data-auth-progress]')?.setAttribute('hidden', ''); }
  async function googleRequest(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (path !== '/auth/google/verify') return api(path, { method: 'POST', body });
    if (mutating || signedIn) throw new ControlError('A sign-in is already in progress. Continue with your current sign-in.', 'auth_in_progress');
    const controls = qa<HTMLInputElement | HTMLButtonElement>('[data-signup-email] input,[data-signup-email] button,[data-signup-verify] input,[data-signup-verify] button,[data-resend-code],[data-change-email],[data-github-start]');
    const disabled = controls.map(control => control.disabled);
    mutating++; controls.forEach(control => { control.disabled = true; });
    try { return await api(path, { method: 'POST', body }); }
    finally { mutating--; controls.forEach((control, index) => { control.disabled = disabled[index]; }); }
  }
  function setGithubBusy(busy: boolean): boolean {
    if (busy) {
      if (mutating || signingOut || githubInProgress) return false;
      githubInProgress = true; mutating++;
      disposeGoogle?.(); disposeGoogle = undefined;
      githubControls = qa<HTMLInputElement | HTMLButtonElement>('form input,form button,[data-resend-code],[data-change-email],[data-logout],[data-github-start],[data-github-connect]').map(control => ({ control, disabled: control.disabled }));
      githubControls.forEach(({ control }) => { control.disabled = true; });
      q('[data-google-signin]')?.setAttribute('aria-busy', 'true');
    } else if (githubInProgress) {
      githubInProgress = false; mutating--;
      githubControls.forEach(({ control, disabled }) => { control.disabled = disabled; }); githubControls = [];
      q('[data-google-signin]')?.removeAttribute('aria-busy');
      if (!signedIn && !leavingPage) enableGoogle();
    }
    return true;
  }
  function githubRequest(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> { return api(path, { method: 'POST', body }); }
  function enableGoogle() {
    const google = service.google, container = q('[data-google-signin]');
    if (google?.enabled === true && typeof google.client_id === 'string' && container && !disposeGoogle) disposeGoogle = mountGoogleSignIn({ container, clientId: google.client_id, request: googleRequest, onSession: finishSignIn });
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
    if (signingOut || githubInProgress) return;
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
    resetPlayground();
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
    ready = true; draftOpen = true; currentResult = null; currentKey = pendingKeys().at(-1) || ''; if (currentKey) draftOpen = false;
    renderProfiles(); renderKeys(); renderRequests(); renderUsage(); renderChecklist(); renderResult(null);
    q('[data-workspace-gate]')!.hidden = true; q('[data-workspace-content]')!.hidden = false; updateRunButton();
  }
  async function refreshKeys() { const id = project?.id; const data = await api(projectPath('/keys')); if (id !== project?.id) return; keys = data.keys || []; renderKeys(); renderChecklist(); }
  async function refreshHistory() { const version = loadVersion; const data = await api(projectPath('/requests')); if (version !== loadVersion) return; operations = data.operations || []; renderRequests(); renderChecklist(); }
  async function refreshAccounting() { const version = loadVersion; const results = await Promise.allSettled([api(projectPath('/usage')), api(projectPath('/billing')), refreshHistory()]); if (version !== loadVersion) return; usage = results[0].status === 'fulfilled' ? results[0].value : null; billing = results[1].status === 'fulfilled' ? results[1].value : null; renderUsage(); if (results.some(result => result.status === 'rejected')) setError('The request result is shown, but some usage or history data could not be refreshed. Use Refresh to read it again.'); }
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
    const status = billing?.status; textAll('[data-billing-status]', status === 'trial' ? 'Trial access' : status === 'approval_required' ? 'Approval required' : 'Status unavailable'); textAll('[data-billing-description]', status === 'trial' ? 'Your trial allocation is active. Check the playground for available routes and request costs.' : status === 'approval_required' ? 'Contact FetchX for a reviewed credit grant or commercial access.' : 'The service did not return a billing status. Refresh to read it again.');
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
  function previewField(value: unknown, limit: number) {
    if (value === undefined) return undefined;
    return JSON.stringify(value, null, 2).length <= limit ? value : '[Preview omitted: field exceeds display limit]';
  }
  function previewResult(result: Json) {
    // Never insert remote HTML, even for text/html; omit bulky binary data and
    // cap text before serializing the response inspector.
    const data = result.data ? { ...result.data, body_base64: result.data.body_base64 ? `[${result.data.body_base64.length} base64 characters omitted]` : null, text: typeof result.data.text === 'string' ? result.data.text.slice(0, 32000) + (result.data.text.length > 32000 ? '\n[Source text truncated at 32,000 characters]' : '') : null } : null;
    return JSON.stringify({ ...result, data, artifacts: previewField(result.artifacts, 12000), diagnostics: previewField(result.diagnostics, 12000) }, null, 2);
  }
  async function openRequest(id: string) {
    const originalProject = project?.id; lastFocus = document.activeElement as HTMLElement; const dialog = q<HTMLDialogElement>('[data-request-dialog]'); if (!dialog) return; textAll('[data-request-detail]', 'Loading retained response…'); textAll('[data-request-detail-status]', 'Read-only lookup. No source request is dispatched.'); dialog.showModal();
    try { const result = await api(projectPath('/requests/' + encodeURIComponent(id)), { publicFetch: true }); if (originalProject !== project?.id || !dialog.open) return; textAll('[data-request-detail]', previewResult(result)); textAll('[data-request-detail-status]', `State: ${result.state}. Application acceptance: ${result.application_acceptance || 'not evaluated'}.`); } catch (error) { if (dialog.open) textAll('[data-request-detail]', error instanceof Error ? error.message : String(error)); }
  }
  q('[data-request-search]')?.addEventListener('input', renderRequests); q('[data-request-filter]')?.addEventListener('change', renderRequests);
  q('[data-refresh-history]')?.addEventListener('click', async event => { const button = event.currentTarget as HTMLButtonElement; button.disabled = true; clearError(); try { await refreshHistory(); } catch (error) { setError(error); } finally { button.disabled = false; } });

  const requestForm = q<HTMLFormElement>('[data-playground-form]');
  const requestUrl = q<HTMLInputElement>('[data-request-url]');
  const routeSelect = q<HTMLSelectElement>('[data-request-route]');
  const countrySelect = q<HTMLSelectElement>('[data-request-country]');
  const countrySearch = q<HTMLInputElement>('[data-country-search]');
  const methodSelect = q<HTMLSelectElement>('[data-request-method]');
  const keySelect = q<HTMLSelectElement>('[data-request-key]');
  const waitInput = q<HTMLInputElement>('[data-request-wait]');
  const screenshotInput = q<HTMLInputElement>('[data-request-screenshot]');
  const tabs = qa<HTMLButtonElement>('[data-inspector-tab]');
  const preferredKeys = new Map<string, string>();
  const bridgeDeadlineMs = 90_000; // Wait beyond the control bridge's 85-second deadline.
  const previewTextLimit = 32_000;
  let preparedRequest: Preparation | null = null, preparedSignature = '';
  let preparedCapabilities: PlaygroundCapabilities | null = null, preparedKeys: SafeKey[] | null = null;
  let prepareTimer: ReturnType<typeof setTimeout> | undefined, prepareVersion = 0;
  let prepareError = '', checkingRequest = false, preferredCountry = '';
  let hasRouteChoice = false;
  let submittedRequest: { execution: Execution; body: Json } | null = null;
  let retainedScreenshot: string | null = null;
  let retainedHeaders: string | null = null;

  const hide = (selector: string, hidden: boolean) => { const node = q(selector); if (node) node.hidden = hidden; };
  const execution = (): Execution => q<HTMLInputElement>('input[name="mode"]:checked')?.value === 'browser' ? 'browser' : 'http';
  const baseCapabilities = (): PlaygroundCapabilities | null => {
    const value = capabilities.playground;
    return Array.isArray(value?.executions) && value.executions.length && Array.isArray(value.routes) &&
      !value.executions.every((mode: Json) => mode.reason === 'playground_disabled') ? value : null;
  };
  const activeCapabilities = () => preparedCapabilities || baseCapabilities();
  const selectedProfile = () => profiles.find(item => `${item.id}@${item.version}` === q<HTMLSelectElement>('[data-request-profile]')?.value);
  const currentExecutionCapability = () => activeCapabilities()?.executions.find(item => item.id === execution());
  const routeChoice = () => routeClasses.find(value => value === routeSelect?.value);
  const explicitKey = () => project ? preferredKeys.get(project.id) || '' : '';
  const keyOptions = (): SafeKey[] => preparedKeys ?? keys.filter(key => typeof key.id === 'string' && !key.revoked_at && key.scopes?.includes('fetch:write')) as SafeKey[];
  const keyChoice = () => explicitKey() || (keyOptions().length === 1 ? keyOptions()[0].id : '');

  function explainAvailability(reason?: string | null) {
    if (reason?.startsWith('browser_probe_')) return 'The browser service is temporarily unavailable.';
    switch (reason) {
      case 'playground_disabled': return 'This project uses its existing approved HTTP profiles.';
      case 'playground_execution_unreviewed': return 'This execution mode has no configured routes.';
      case 'playground_no_route': return 'No route is currently available for this execution mode.';
      case 'playground_target_required': return 'Enter the URL to check availability for this website.';
      case 'playground_route_unreviewed':
      case 'credit_route_forbidden': return 'No configuration for this execution mode.';
      case 'playground_route_unhealthy': return 'The proxy pool is temporarily unavailable.';
      case 'country_pool_unavailable': return 'There is no available proxy pool for this location.';
      case 'residential_provider_unavailable': return 'The residential proxy service is unavailable.';
      case 'residential_provider_held':
      case 'residential_budget_exhausted': return 'The residential route has reached a service limit.';
      case 'cost_estimate_unavailable':
      case 'cost_ceiling_exceeded': return 'A bounded cost is unavailable for this route.';
      default: return 'Unavailable for this execution mode.';
    }
  }
  function routeAvailability(value: RouteClass) {
    const mode = execution(), matrix = activeCapabilities();
    if (matrix) {
      const entry = matrix.routes.find(item => item.class === value);
      return entry?.executions?.[mode] ?? (entry?.executions ? undefined : entry) ?? { available: false, reason: 'playground_route_unreviewed', countries: [] };
    }
    const profile = selectedProfile(), allowed = Array.isArray(capabilities.routes) ? capabilities.routes : ['direct'];
    const countries = (profile?.route_reservations || []).filter(row => row.class === value && typeof row.country === 'string').map(row => row.country as string);
    const available = mode === 'http' && capabilities.native_http !== false && allowed.includes(value) &&
      Boolean(profile?.proxy_classes.includes(value)) && (value === 'direct' || countries.length > 0);
    return { available, reason: available ? null : 'playground_route_unreviewed', countries };
  }
  function renderProfiles() {
    const select = q<HTMLSelectElement>('[data-request-profile]'); if (!select) return;
    select.replaceChildren(...profiles.map(profile => new Option(`${profile.id} · v${profile.version}`, `${profile.id}@${profile.version}`)));
    select.disabled = !profiles.length;
    hide('[data-request-profile-field]', Boolean(baseCapabilities()) || profiles.length <= 1);
    renderRequestControls();
    schedulePreparation();
  }
  function renderRequestControls() {
    if (!routeSelect || !methodSelect) return;
    const matrix = activeCapabilities(), mode = execution(), profile = selectedProfile();
    for (const input of qa<HTMLInputElement>('input[name="mode"]')) {
      const capability = matrix?.executions.find(item => item.id === input.value);
      input.disabled = matrix ? capability?.available !== true : input.value === 'browser' || capabilities.native_http === false;
      const description = input.disabled
        ? matrix ? explainAvailability(capability?.reason) : input.value === 'browser' ? 'Unavailable on this service' : 'HTTP service is unavailable'
        : input.value === 'browser' ? 'Rendered page' : 'Source response';
      textAll(`[data-execution-help="${input.value}"]`, description);
    }
    const previous = routeChoice();
    const values = routeClasses.map(value => {
      const availability = routeAvailability(value);
      const option = new Option(routeLabels[value] + (availability.available ? '' : ' · unavailable'), value);
      option.disabled = !availability.available; return option;
    });
    routeSelect.replaceChildren(new Option('Choose a route', ''), ...values);
    routeSelect.options[0].disabled = true;
    routeSelect.value = previous ?? (!hasRouteChoice && routeAvailability('direct').available ? 'direct' : '');
    const unavailable = new Map<string, string[]>();
    for (const route of routeClasses) {
      const availability = routeAvailability(route);
      if (availability.available) continue;
      const reason = explainAvailability(availability.reason);
      const labels = unavailable.get(reason) ?? [];
      labels.push(routeLabels[route]);
      unavailable.set(reason, labels);
    }
    textAll('[data-route-help]', [...unavailable].map(([reason, labels]) => `${labels.join(' and ')}: ${reason}`).join(' '));
    const oldMethod = methodSelect.value;
    const methods = (matrix ? currentExecutionCapability()?.methods ?? (mode === 'http' ? ['GET', 'HEAD'] : ['GET']) : profile?.methods || []).filter(value => value === 'GET' || value === 'HEAD');
    methodSelect.replaceChildren(...methods.map(method => new Option(method, method)));
    if (methods.some(method => method === oldMethod)) methodSelect.value = oldMethod;
    hide('[data-request-method-field]', methods.length <= 1);
    const allowedHeaders = mode === 'http' && matrix ? currentExecutionCapability()?.headers || [] : [];
    for (const input of qa<HTMLInputElement>('[data-request-header]')) {
      input.disabled = !allowedHeaders.includes(input.dataset.requestHeader || '');
      (input.closest('[data-header-field]') as HTMLElement).hidden = input.disabled;
    }
    hide('[data-request-headers]', !allowedHeaders.length);
    hide('[data-screenshot-field]', mode !== 'browser' || currentExecutionCapability()?.available !== true);
    const waitMax = currentExecutionCapability()?.max_wait_ms;
    const hasWait = mode === 'browser' && typeof waitMax === 'number' && Number.isSafeInteger(waitMax) && waitMax >= 0 && waitMax <= 2000;
    hide('[data-wait-field]', !hasWait);
    if (waitInput) {
      waitInput.disabled = !hasWait;
      if (hasWait) waitInput.max = String(waitMax);
    }
    textAll('[data-profile-summary]', matrix
      ? preparedRequest?.access_profile ? 'FetchX matched an access policy for this website and execution mode.' : 'FetchX checks the destination and chooses an access policy automatically.'
      : profile ? `Approved destinations: ${profile.origins.join(', ')}${profile.paths?.length ? ' · Paths: ' + profile.paths.join(', ') : ''}` : 'No approved HTTP access profile is configured.');
    textAll('#request-url-help', matrix ? 'Use a public HTTPS URL.' : 'Use a public HTTPS URL approved by this project’s profile.');
    renderCountries();
    renderKeyChoice();
  }
  function renderCountries() {
    if (!countrySelect || !countrySearch) return;
    const route = routeChoice();
    const proxy = route === 'datacenter' || route === 'residential';
    const availability = route ? routeAvailability(route) : null;
    hide('[data-country-search-field]', !proxy || !availability?.available);
    countrySelect.disabled = !proxy || !availability?.available;
    if (!proxy || !availability?.available) {
      countrySelect.replaceChildren(new Option(route === 'direct' ? 'Location not selectable' : 'Choose an available proxy route', ''));
      textAll('[data-country-help]', route === 'direct' ? 'Use a proxy to select a location.' : '');
      return;
    }
    const supported = new Set(availability.countries);
    const query = countrySearch.value.trim().toLowerCase();
    const matching = countries.filter(({ code, name }) => !query || code.toLowerCase().includes(query) || name.toLowerCase().includes(query) || `${name} (${code})`.toLowerCase().includes(query));
    const placeholder = new Option(matching.length ? 'Choose a country' : 'No countries match', '');
    placeholder.disabled = true;
    const groups = [element('optgroup'), element('optgroup')];
    groups[0].label = 'Available'; groups[1].label = 'Unavailable on this route';
    for (const { code, name } of matching) {
      const enabled = supported.has(code);
      const option = new Option(`${name} (${code})`, code);
      option.disabled = !enabled; groups[enabled ? 0 : 1].append(option);
    }
    countrySelect.replaceChildren(placeholder, ...groups.filter(group => group.childElementCount > 0));
    countrySelect.value = supported.has(preferredCountry) && matching.some(item => item.code === preferredCountry) ? preferredCountry : '';
    textAll('[data-country-help]', `${supported.size} supported ${supported.size === 1 ? 'country' : 'countries'}. Other locations are unavailable for this route and execution mode.`);
  }
  function renderKeyChoice() {
    if (!keySelect || !project) return;
    const managed = Boolean(baseCapabilities()), eligible = keyOptions();
    hide('[data-request-keys]', !managed);
    if (!managed) return;
    if (!eligible.some(item => item.id === explicitKey())) preferredKeys.delete(project.id);
    keySelect.replaceChildren(new Option('Choose a key', ''), ...eligible.map(item => new Option(`${item.name || 'API key'} · …${item.id.slice(-8)}`, item.id)));
    keySelect.value = keyChoice();
    hide('[data-request-key-field]', eligible.length <= 1);
    hide('[data-request-key-empty]', eligible.length > 0);
    hide('[data-selected-key]', eligible.length !== 1);
    textAll('[data-selected-key]', eligible.length === 1 ? `API key: ${eligible[0].name || 'Project key'}` : '');
  }

  function draftInput(): Json | null {
    const url = requestUrl?.value.trim(), mode = execution(), route = routeChoice(), method = methodSelect?.value, country = countrySelect?.value;
    if (!url || requestUrl?.validity.typeMismatch || !route || !routeAvailability(route).available || !method ||
        activeCapabilities() && currentExecutionCapability()?.available !== true ||
        route !== 'direct' && (!country || !routeAvailability(route).countries.includes(country))) return null;
    return { url, execution: mode, method, proxy: { class: route, country: route === 'direct' ? null : country }, ...(explicitKey() ? { key_id: explicitKey() } : {}) };
  }
  function clearPreparation() {
    clearTimeout(prepareTimer); ++prepareVersion;
    preparedRequest = null; preparedSignature = ''; prepareError = ''; checkingRequest = false;
  }
  function schedulePreparation() {
    clearPreparation();
    const draft = draftInput(), url = requestUrl?.value.trim();
    if (ready && draftOpen && !sending && baseCapabilities() && url && !requestUrl?.validity.typeMismatch) {
      // The project matrix can be provisional for a profile-priced route. A
      // URL alone can resolve the actual matrix before any proxy is selectable.
      const input = draft ?? {
        url, execution: execution(), method: methodSelect?.value || 'GET', proxy: { class: 'direct', country: null },
        ...(explicitKey() ? { key_id: explicitKey() } : {}),
      };
      checkingRequest = true;
      const id = project?.id, version = prepareVersion;
      prepareTimer = setTimeout(() => { void prepareRequest(input, id, version, Boolean(draft)); }, 300);
    }
    updateRunButton(); renderCode();
  }
  async function prepareRequest(input: Json, id: string | undefined, version: number, chosenRoute: boolean) {
    const active = () => id === project?.id && version === prepareVersion && !leavingPage;
    if (!active() || !draftOpen || sending) return;
    try {
      const data = await api(projectPath('/playground/prepare'), { method: 'POST', body: input }) as Preparation;
      if (!active()) return;
      preparedCapabilities = data.capabilities || null;
      preparedKeys = Array.isArray(data.keys) ? data.keys : null;
      preparedRequest = data;
      preparedSignature = JSON.stringify(input);
      prepareError = (data.errors || []).filter(error => chosenRoute || error.field === 'url' || error.field === 'key_id')
        .map(error => error.message).filter(Boolean).join(' ').slice(0, 1000);
      const invalidUrl = (data.errors || []).some(error => error.field === 'url');
      if (invalidUrl) requestUrl?.setAttribute('aria-invalid', 'true');
      renderRequestControls();
      const resolvedDraft = draftInput();
      if (!chosenRoute && !invalidUrl && resolvedDraft && JSON.stringify(resolvedDraft) !== preparedSignature) schedulePreparation();
    } catch (error) {
      if (!active()) return;
      preparedRequest = null; preparedSignature = '';
      prepareError = error instanceof ControlError && error.code === 'timeout' ? 'The request check timed out. Change a setting to check again.' :
        error instanceof Error ? error.message : 'Could not check this request.';
    } finally {
      if (active()) { checkingRequest = false; updateRunButton(); renderCode(); }
    }
  }
  function requestIssue() {
    if (!requestUrl?.value.trim()) return 'Enter a URL to check the request.';
    if (requestUrl.validity.typeMismatch) return 'Enter a complete URL, including https://.';
    if (!baseCapabilities() && !selectedProfile()) return 'No approved HTTP profile is configured for this project.';
    if (baseCapabilities() && currentExecutionCapability()?.available !== true) return explainAvailability(currentExecutionCapability()?.reason);
    if (!routeChoice() || !routeAvailability(routeChoice()!).available) return 'Choose an available route.';
    if (routeChoice() !== 'direct' && !countrySelect?.value) return 'Choose a supported country.';
    if (baseCapabilities() && !keyChoice()) return keyOptions().length ? 'Choose an API key.' : 'A project API key is required.';
    if (waitInput && !waitInput.disabled && !waitInput.validity.valid) return `Enter a whole number from 0 to ${waitInput.max} for the browser wait.`;
    if (qa<HTMLInputElement>('[data-request-header]').some(input => !input.disabled && /[\u0000-\u0008\u000a-\u001f\u007f\u0100-\uffff]/u.test(input.value))) return 'Request headers must use printable HTTP characters.';
    return '';
  }
  function currentDraftBody(): Json | null {
    const input = draftInput(), managed = Boolean(baseCapabilities());
    const profile = managed ? preparedRequest?.access_profile : selectedProfile();
    if (!input || !profile || requestIssue()) return null;
    if (managed && (!preparedRequest?.ready || preparedRequest.selected_key_id !== keyChoice() || preparedSignature !== JSON.stringify(input))) return null;
    const maximum = preparedRequest?.quote?.max_estimated_micro_usd;
    const body: Json = {
      access_profile: { id: profile.id, version: profile.version },
      url: managed ? preparedRequest?.url || input.url : input.url, proxy: input.proxy,
      ...(typeof maximum === 'number' ? { max_estimated_micro_usd: maximum } : {}),
      ...(managed && explicitKey() ? { key_id: explicitKey() } : {}),
    };
    if (input.execution === 'browser') {
      if (screenshotInput?.checked) body.screenshot = true;
      if (waitInput && !waitInput.disabled && waitInput.value !== '') body.wait_ms = waitInput.valueAsNumber;
    } else {
      body.method = input.method;
      const headers = Object.fromEntries(qa<HTMLInputElement>('[data-request-header]').filter(header => !header.disabled && header.value.trim())
        .map(header => [header.dataset.requestHeader, header.value.trim()]));
      if (Object.keys(headers).length) body.headers = headers;
    }
    return body;
  }
  function updateRunButton() {
    q<HTMLSelectElement>('[data-project-select]')?.toggleAttribute('disabled', sending || mutating > 0 || !projects.length);
    const button = q<HTMLButtonElement>('[data-run-request]'); if (!button) return;
    const body = ready && draftOpen && !sending ? currentDraftBody() : null;
    button.disabled = !body;
    button.textContent = sending ? 'Waiting for result…' : 'Send request →';
    button.hidden = !draftOpen && !sending;
    const config = q<HTMLFieldSetElement>('[data-request-config]');
    if (config) { config.disabled = sending || !draftOpen; config.hidden = !draftOpen && !submittedRequest; }
    const fresh = q<HTMLButtonElement>('[data-new-request]');
    if (fresh) { fresh.disabled = sending || !ready; fresh.hidden = draftOpen && !pendingKeys().length; }
    const recover = q<HTMLButtonElement>('[data-recover-result]'); if (recover) recover.disabled = sending || !ready || !recoveryKey();
    const pending = q<HTMLSelectElement>('[data-pending-operation]'); if (pending) pending.disabled = sending || !ready;
    const quote = preparedRequest?.quote;
    const credits = quote?.credits;
    const estimate = typeof credits === 'number'
      ? `Reserves up to ${number(credits)} ${credits === 1 ? 'credit' : 'credits'}${quote?.max_estimated_micro_usd != null && quote.max_estimated_micro_usd > 0 ? ' · cost ceiling $' + (quote.max_estimated_micro_usd / 1_000_000).toFixed(6) : ''}.`
      : 'Approved profile limits apply.';
    const quoteText = sending ? 'Waiting for the saved result…' : !draftOpen ? '' : checkingRequest ? 'Checking access, route, and cost…' :
      prepareError || requestIssue() || (body ? estimate : 'Check the request settings before sending.');
    const quoteNode = q('[data-request-quote]');
    if (quoteNode) {
      if (quoteNode.textContent !== quoteText) quoteNode.textContent = quoteText;
      quoteNode.hidden = !quoteText;
    }
  }
  function recoveryKey() { return q<HTMLSelectElement>('[data-pending-operation]')?.value || currentKey; }
  function renderRecovery() {
    const pending = pendingKeys(), select = q<HTMLSelectElement>('[data-pending-operation]');
    if (select) {
      const previous = select.value;
      select.replaceChildren(...pending.map(key => new Option(`${operationExecution(key) === 'browser' ? 'Browser' : 'HTTP'} · ${key}`, key)));
      select.value = pending.includes(currentKey) ? currentKey : pending.includes(previous) ? previous : pending.at(-1) || '';
    }
    hide('[data-pending-label]', !pending.length);
    hide('[data-recover-result]', !recoveryKey());
    hide('[data-recovery-note]', !recoveryKey());
    hide('[data-operation-row]', !currentKey);
    textAll('[data-operation-key]', currentKey);
    updateRunButton(); renderCode();
  }
  function renderResult(result: Json | null) {
    currentResult = result;
    const mode = currentKey ? operationExecution(currentKey) : submittedRequest?.execution || execution();
    const state = result?.state || (currentKey ? 'Pending recovery' : 'Ready');
    textAll('[data-response-state]', state[0].toUpperCase() + state.slice(1));
    const badge = q('[data-response-state]');
    if (badge) badge.className = 'pp-status pp-status-' + (['completed','failed','running','unknown'].includes(state) ? state : 'running');
    const retained = result?.data;
    const bodyText = typeof retained?.text === 'string' ? retained.text : null;
    const output = bodyText !== null ? bodyText.slice(0, previewTextLimit) + (bodyText.length > previewTextLimit ? '\n[Source text truncated at 32,000 characters. Download for the full retained body.]' : '') :
      retained?.body_base64 ? 'A binary body was retained. Download it to inspect the bytes.' :
      state === 'running' ? 'Waiting for the gateway response…' : currentKey ? 'No source body is available for this operation.' : 'Send a request to inspect the response body.';
    textAll('[data-response-output]', output);
    const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
    const screenshot = mode === 'browser' && artifacts.find((artifact: Json) => artifact.kind === 'browser_screenshot' && artifact.content_type === 'image/jpeg');
    const image = q<HTMLImageElement>('[data-browser-screenshot]');
    retainedScreenshot = typeof screenshot?.body_base64 === 'string' && screenshot.body_base64.length <= 4 * Math.ceil(1_048_576 / 3) &&
      /^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(screenshot.body_base64) ? screenshot.body_base64 : null;
    if (image) { if (retainedScreenshot) image.src = 'data:image/jpeg;base64,' + retainedScreenshot; else image.removeAttribute('src'); }
    const screenshotTab = q<HTMLButtonElement>('[data-inspector-tab="screenshot"]');
    if (screenshotTab) {
      if (!retainedScreenshot && screenshotTab.getAttribute('aria-selected') === 'true') selectTab(tabs[0]);
      screenshotTab.hidden = !retainedScreenshot;
    }
    textAll('[data-body-description]', mode === 'browser' && bodyText !== null ? 'Rendered DOM' : 'Response body');
    hide('[data-copy-body]', bodyText === null);
    hide('[data-download-body]', bodyText === null && !retained?.body_base64);
    const headers = retained?.headers;
    retainedHeaders = headers && typeof headers === 'object' && !Array.isArray(headers) && Object.keys(headers).length ? JSON.stringify(headers, null, 2) : null;
    textAll('[data-response-headers]', retainedHeaders && retainedHeaders.length <= 24_000 ? retainedHeaders : retainedHeaders ? 'The retained headers exceed the preview limit. Copy headers to read them.' : 'No source headers retained.');
    hide('[data-copy-headers]', !retainedHeaders);
    textAll('[data-response-diagnostics]', result ? JSON.stringify({
      state, operation_id: result.operation_id ?? null, execution: mode, gateway_http_status: result.gateway_http_status ?? null,
      source: retained ? { status: retained.status, final_url: retained.final_url, content_type: retained.content_type } : null,
      routing: result.routing, usage: previewField(result.usage, 12000), diagnostics: previewField(result.diagnostics, 24000),
      artifacts: previewField(artifacts.map(({ body_base64, ...metadata }: Json) => metadata), 12000),
      retry: previewField(result.retry, 8000), error: result.error ?? null,
    }, null, 2) : 'No diagnostics yet.');
    const note = result
      ? state === 'running' ? 'Request sent. Keep the operation key for recovery.' :
        result.success ? 'Source response retained. Check the body for the content you expected.' :
        state === 'unknown' ? 'The outcome is uncertain. Recover the saved operation before sending again.' : 'Operation state retained.'
      : currentKey ? 'Read the saved result using its operation key.' : 'No request has been sent.';
    const blocked = result?.usage?.blocked_requests;
    const partial = mode === 'browser' && result?.usage?.capture_complete === false;
    const captureNote = partial ? ' Partial capture.' + (Number.isSafeInteger(blocked) && blocked > 0 ? ` ${number(blocked)} ${blocked === 1 ? 'request was' : 'requests were'} blocked.` : '') : '';
    textAll('[data-response-note]', note + captureNote);
    if (result?.error) setError(result.error.message || result.error.code || 'The operation could not complete.', '[data-response-error]');
    else clearError('[data-response-error]');
    const route = result?.routing;
    const duration = result?.usage?.duration_ms ?? result?.duration_ms;
    const bytes = result?.usage?.decoded_bytes ?? result?.usage?.encoded_bytes;
    const credit = result?.usage?.accounting?.request_credits ?? result?.request_credits;
    const creditState = { settled: 'used', released: 'released', reserved: 'reserved', held: 'held' } as Record<string, string>;
    hide('[data-result-facts]', !result || state === 'running');
    textAll('[data-result-source]', typeof retained?.status === 'number' ? `HTTP ${retained.status}` : 'No response');
    textAll('[data-result-route]', routeClasses.includes(route?.class) ? routeLabels[route.class as RouteClass] : '—');
    textAll('[data-result-country]', route?.class === 'direct' ? 'Not selectable' : typeof route?.country === 'string' && /^[A-Z]{2}$/.test(route.country) ? `${countryName(route.country)} (${route.country})` : '—');
    textAll('[data-result-duration]', typeof duration === 'number' ? `${number(Math.round(duration))} ms` : '—');
    textAll('[data-result-bytes]', number(bytes));
    textAll('[data-result-credits]', typeof credit?.credits === 'number' ? `${number(credit.credits)} ${creditState[credit.state] || ''}`.trim() : '—');
    renderRecovery();
  }

  function resetPlayground() {
    clearPreparation(); preparedCapabilities = null; preparedKeys = null; hasRouteChoice = false; preferredCountry = '';
    draftOpen = true; currentKey = ''; currentResult = null; submittedRequest = null;
    requestForm?.reset(); requestUrl?.removeAttribute('aria-invalid');
    if (routeSelect) routeSelect.replaceChildren();
    q('[data-pending-operation]')?.replaceChildren();
    q<HTMLDetailsElement>('[data-request-advanced]')?.removeAttribute('open');
    const codeOperation = q<HTMLSelectElement>('[data-code-operation]'); if (codeOperation) codeOperation.value = 'send';
    clearError('[data-fetch-error]');
    if (tabs[0]) selectTab(tabs[0]);
  }
  function newRequest() {
    draftOpen = true; currentKey = ''; submittedRequest = null;
    const codeOperation = q<HTMLSelectElement>('[data-code-operation]'); if (codeOperation) codeOperation.value = 'send';
    clearError('[data-fetch-error]'); renderResult(null); schedulePreparation(); requestUrl?.focus();
  }
  q('[data-new-request]')?.addEventListener('click', () => {
    if (sending) return;
    if (pendingKeys().length) confirmAction('Start a deliberate new request?', 'The saved requests remain available to recover. Sending this request creates a separate operation and may use additional credits.', 'Start new request', newRequest);
    else newRequest();
  });
  requestForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!ready || !draftOpen || sending || !project) return;
    const input = currentDraftBody();
    if (!input || !requestForm.reportValidity()) return;
    const id = project.id, version = loadVersion, mode = execution(), key = (mode === 'browser' ? 'render_' : 'console_') + crypto.randomUUID(), path = projectPath(operationResource(mode));
    const body = { ...input, idempotency_key: key };
    clearError('[data-fetch-error]');
    try { savePending(id, key); } catch (error) { setError(error, '[data-fetch-error]'); return; } // A storage failure prevents dispatch.
    clearPreparation(); submittedRequest = { execution: mode, body };
    currentKey = key; draftOpen = false; sending = true;
    renderResult({ state: 'running' });
    try {
      const result = await api(path, { method: 'POST', body, publicFetch: true, timeout: bridgeDeadlineMs });
      if (['completed','failed','rejected'].includes(result.state)) clearPending(id, key);
      if (version === loadVersion && id === project?.id) renderResult(result);
    } catch (error) {
      if (version === loadVersion && id === project?.id) renderResult({ state: 'unknown', success: false, idempotency_key: key, error: { code: error instanceof ControlError ? error.code : 'network_error', message: error instanceof Error ? error.message : 'The operation outcome is unknown.' } });
    } finally {
      if (version === loadVersion && id === project?.id) { sending = false; renderRecovery(); await refreshAccounting(); }
    }
  });
  q('[data-recover-result]')?.addEventListener('click', async () => {
    const key = recoveryKey();
    if (!key || sending || !ready || !project) return;
    const id = project.id, version = loadVersion, path = projectPath(operationResource(operationExecution(key)) + '/' + encodeURIComponent(key));
    if (key !== currentKey) submittedRequest = null;
    clearPreparation(); sending = true; currentKey = key; draftOpen = false; clearError('[data-fetch-error]'); renderResult(null);
    textAll('[data-response-note]', 'Reading the saved operation…');
    try {
      const result = await api(path, { publicFetch: true, timeout: bridgeDeadlineMs });
      if (result.operation_id && ['completed','failed'].includes(result.state)) clearPending(id, key);
      if (version === loadVersion && id === project?.id) renderResult(result);
    } catch (error) {
      if (version === loadVersion && id === project?.id) {
        setError(error, '[data-response-error]');
        textAll('[data-response-note]', 'Recovery could not confirm an outcome. The key remains saved.');
      }
    } finally {
      if (version === loadVersion && id === project?.id) { sending = false; renderRecovery(); await refreshAccounting(); }
    }
  });
  function renderCode() {
    const control = q<HTMLSelectElement>('[data-code-operation]'), copyButton = q<HTMLButtonElement>('[data-copy-code]');
    if (!control || !copyButton) return;
    const key = currentKey || recoveryKey();
    const recover = control.querySelector<HTMLOptionElement>('option[value="recover"]')!;
    recover.disabled = !key;
    if (!key && control.value === 'recover') control.value = 'send';
    const recovery = control.value === 'recover', body = recovery ? null : submittedRequest?.body ?? (draftOpen ? currentDraftBody() : null);
    copyButton.disabled = !recovery && !body;
    if (copyButton.disabled) {
      textAll('[data-generated-code]', key ? 'Choose Recover this request to look up the saved operation, or prepare a new request.' : 'Prepare a request to generate code.');
      return;
    }
    const mode = recovery ? operationExecution(key) : submittedRequest?.execution || execution();
    const base = String(service.api_base_url || 'https://YOUR_FETCHX_API').replace(/\/$/, '');
    textAll('[data-generated-code]', requestCode(base, mode, q<HTMLSelectElement>('[data-code-language]')?.value || 'curl', body, recovery ? key : ''));
  }
  function changeDraft(resetMatrix = false) {
    clearError('[data-fetch-error]'); requestUrl?.removeAttribute('aria-invalid');
    if (resetMatrix) { preparedCapabilities = null; renderRequestControls(); }
    schedulePreparation();
  }
  q('[data-request-profile]')?.addEventListener('change', () => { renderRequestControls(); changeDraft(); });
  qa('input[name="mode"]').forEach(input => input.addEventListener('change', () => {
    if (countrySearch) countrySearch.value = '';
    renderRequestControls(); changeDraft();
  }));
  routeSelect?.addEventListener('change', () => {
    hasRouteChoice = true;
    if (countrySearch) countrySearch.value = '';
    renderCountries(); changeDraft();
  });
  countrySearch?.addEventListener('input', () => { renderCountries(); changeDraft(); });
  countrySelect?.addEventListener('change', () => { preferredCountry = countrySelect.value; changeDraft(); });
  keySelect?.addEventListener('change', () => {
    if (project) { if (keySelect.value) preferredKeys.set(project.id, keySelect.value); else preferredKeys.delete(project.id); }
    changeDraft();
  });
  methodSelect?.addEventListener('change', () => changeDraft());
  requestUrl?.addEventListener('input', () => changeDraft(true));
  qa('[data-request-wait],[data-request-screenshot],[data-request-header]').forEach(input => input.addEventListener('input', () => { updateRunButton(); renderCode(); }));
  q('[data-pending-operation]')?.addEventListener('change', renderCode);
  q('[data-code-language]')?.addEventListener('change', renderCode);
  q('[data-code-operation]')?.addEventListener('change', renderCode);
  q('[data-copy-code]')?.addEventListener('click', () => { void copy(q('[data-generated-code]')?.textContent || ''); });
  q('[data-copy-body]')?.addEventListener('click', () => { if (typeof currentResult?.data?.text === 'string') void copy(currentResult.data.text); });
  q('[data-copy-headers]')?.addEventListener('click', () => { if (retainedHeaders) void copy(retainedHeaders); });
  function download(blob: Blob, filename: string) {
    const href = URL.createObjectURL(blob), anchor = element('a');
    anchor.href = href; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1_000);
  }
  function downloadBytes(encoded: string, filename: string, type: string) {
    try {
      const raw = atob(encoded), bytes = new Uint8Array(raw.length);
      for (let index = 0; index < bytes.length; index++) bytes[index] = raw.charCodeAt(index);
      download(new Blob([bytes], { type }), filename);
    }
    catch { toast('The retained bytes could not be downloaded.'); }
  }
  q('[data-download-body]')?.addEventListener('click', () => {
    if (typeof currentResult?.data?.text === 'string') download(new Blob([currentResult.data.text], { type: 'text/plain;charset=utf-8' }), 'fetchx-body.txt');
    else if (typeof currentResult?.data?.body_base64 === 'string') downloadBytes(currentResult.data.body_base64, 'fetchx-body.bin', 'application/octet-stream');
  });
  q('[data-download-screenshot]')?.addEventListener('click', () => {
    if (retainedScreenshot) downloadBytes(retainedScreenshot, 'fetchx-screenshot.jpg', 'image/jpeg');
  });
  function selectTab(button: HTMLButtonElement) {
    tabs.forEach(tab => { const selected = tab === button; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
    qa('[data-inspector-panel]').forEach(panel => { panel.hidden = panel.dataset.inspectorPanel !== button.dataset.inspectorTab; });
  }
  tabs.forEach(tab => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const visible = tabs.filter(item => !item.hidden), index = visible.indexOf(tab);
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % visible.length;
      else if (event.key === 'ArrowLeft') next = (index + visible.length - 1) % visible.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = visible.length - 1;
      else return;
      event.preventDefault(); selectTab(visible[next]); visible[next].focus();
    });
  });
  const menu = q<HTMLButtonElement>('[data-app-menu]');
  function closeMenu() { root.classList.remove('pp-menu-open'); menu?.setAttribute('aria-expanded', 'false'); menu?.setAttribute('aria-label', 'Open workspace navigation'); }
  menu?.addEventListener('click', () => { const open = menu.getAttribute('aria-expanded') !== 'true'; root.classList.toggle('pp-menu-open', open); menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? 'Close workspace navigation' : 'Open workspace navigation'); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && root.classList.contains('pp-menu-open')) { closeMenu(); menu?.focus(); } });
  document.addEventListener('click', event => { if (root.classList.contains('pp-menu-open') && !(event.target as Element).closest('.pp-sidebar,[data-app-menu]')) closeMenu(); });
  window.addEventListener('pagehide', () => { leavingPage = true; disposeGoogle?.(); disposeGithub?.(); concealSecret(); csrf = ''; email = ''; challenge = ''; clearPreparation(); currentResult = null; submittedRequest = null; retainedScreenshot = null; retainedHeaders = null; requestForm?.reset(); q('[data-browser-screenshot]')?.removeAttribute('src'); textAll('[data-response-output],[data-response-headers],[data-response-diagnostics],[data-request-detail],[data-generated-code]', ''); });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  q('[data-refresh-workspace]')?.addEventListener('click', () => { if (!sending && !mutating) void start(); });

  async function start() {
    disposeGoogle?.(); disposeGoogle = undefined;
    disposeGithub?.(); disposeGithub = undefined;
    ready = false; signedIn = false; csrf = ''; projects = []; project = null; concealSecret(); clearError();
    qa('[data-logout],[data-session-account],[data-auth-account]').forEach(node => { node.hidden = true; }); setProjectOptions();
    textAll('[data-user-email]', 'Not signed in');
    if (!authPage) gate('Opening your workspace…', 'Checking the service and your session.');
    try {
      service = await api('/status');
      if (!service.enabled) throw new ControlError('Self-service access is not configured on this service. Contact FetchX for access.', 'service_unavailable');
      textAll('[data-service-status]', service.mail_delivery === 'local_private_mailbox' ? 'Local review · private test mailbox' : service.mail_configured || service.google?.enabled || service.github?.enabled ? 'Connected to the control service' : 'Sign-in is not configured');
      textAll('[data-auth-delivery-help]', service.mail_delivery === 'local_private_mailbox' ? 'Local review mode uses a private test mailbox. No email is sent.' : 'We’ll email a one-time code to verify your address.');
      let session: Json | null = null;
      try { session = await api('/session'); } catch (error) { if (!(error instanceof ControlError) || error.status !== 401) throw error; }
      if (session) {
        acceptSession(session);
        if (authPage) {
          if (projects.length) showExistingAccount();
          else stage(2);
        } else { setProjectOptions(); if (projects.length) await selectProject(projects.some(item => item.id === selectedId()) ? selectedId() : projects[0].id); else gate('Create your first project.', 'Your email is verified. Create a project to receive its configured access and allocation.', 'project'); }
      } else if (authPage) {
        const google = service.google;
        if (!service.mail_configured && !google?.enabled && !service.github?.enabled) throw new ControlError('Sign-in is not configured. Contact FetchX to enable account access.', 'auth_unconfigured');
        q<HTMLButtonElement>('[data-signup-email] button')!.disabled = !service.mail_configured;
        if (!service.mail_configured) textAll('[data-auth-delivery-help]', 'Email codes are unavailable right now. Choose an available sign-in method above.');
        const githubContainer = q('[data-github-signin]');
        if (service.github?.enabled === true && githubContainer) disposeGithub = mountGithubSignIn({ container: githubContainer, mode: 'login', request: githubRequest, setBusy: setGithubBusy });
        const divider = q('[data-auth-divider]'); if (divider) divider.hidden = !google?.enabled && !service.github?.enabled;
        enableGoogle();
      } else { signedIn = false; setProjectOptions(); gate('Sign in to continue.', 'Use GitHub, Google or a one-time email code to access your projects.', 'login'); }
      if (githubResult) { if (githubResult.success) { if (session?.auth_methods?.github === true) toast(githubResult.message); } else setError(githubResult.message); }
    } catch (error) {
      textAll('[data-service-status]', 'Service unavailable'); setError(error);
      if (!authPage) gate('Workspace unavailable.', 'The configured control service could not be reached. No account, request, or credit data has been simulated.');
    }
  }
  await start();
}
