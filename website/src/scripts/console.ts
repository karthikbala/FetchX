// The FetchX console: sign-in (email code, Google, GitHub), projects, API keys,
// the playground, request history, credits and purchases. It talks only to the
// same-origin control bridge (/api/control). Secrets stay in memory.
import { mountGoogleSignIn } from './google-sign-in';
import { consumeGithubResult, mountGithubSignIn } from './github-sign-in';
import { clearConnectReturn, readConnectReturn } from './connect-return';
import { mountStripeBilling } from './stripe-billing';
import { isCreditPlanId, formatCredits } from '../data/credit-packages';
import { requestCode } from '../data/console';

type Json = Record<string, any>;
type Project = { id: string; name: string; status: string; created_at?: string };

class ControlError extends Error {
  constructor(message: string, public code: string, public status = 0, public payload: Json | null = null) { super(message); }
}
const STEP_LABELS: Record<string, string> = {
  http: 'HTTP', http_residential: 'HTTP, residential IP', browser: 'Browser', browser_residential: 'Browser, residential IP',
};
const PRICE_LABELS: Record<string, string> = {
  http: 'HTTP (direct or datacenter)', http_residential: 'HTTP over a residential IP', browser: 'Browser',
  browser_residential: 'Browser over a residential IP', captcha: 'Captcha solved (added)',
  residential_overage_per_mb: 'Residential transfer per MB over the included 1 MB (HTTP) or 5 MB (browser)',
};
const INLINE_TEXT_LIMIT = 200_000;

const root = document.querySelector<HTMLElement>('[data-product-preview]');
if (root) void initConsole(root);

async function initConsole(root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(selector: string, parent: ParentNode = root) => parent.querySelector<T>(selector);
  const qa = <T extends HTMLElement = HTMLElement>(selector: string, parent: ParentNode = root) => [...parent.querySelectorAll<T>(selector)];
  const view = root.dataset.view || 'overview';
  const authPage = view === 'signup' || view === 'login';
  const query = new URLSearchParams(window.location.search);
  const plan = query.get('plan');
  const preferredPlan = isCreditPlanId(plan) ? plan : null;
  const billingPath = '/app/billing' + (preferredPlan ? '?plan=' + preferredPlan : '');
  const authDestination = preferredPlan || query.get('view') === 'billing' ? billingPath : '/app';
  const selectedStorage = 'fetchx-selected-project';
  const validProject = (id: unknown): id is string => typeof id === 'string' && /^cp_[a-f0-9-]{36}$/i.test(id);

  let csrf = '', service: Json = {}, projects: Project[] = [], project: Project | null = null;
  let keys: Json[] = [], requests: Json[] = [], nextCursor: string | null = null, usage: Json | null = null, billing: Json | null = null;
  let challenge = '', email = '', revealedSecret = '', currentResult: Json | null = null;
  let signedIn = false, ready = false, sending = false, signingOut = false, leavingPage = false, loadVersion = 0, mutating = 0;
  let toastTimer: ReturnType<typeof setTimeout>;
  let confirmCallback: (() => void) | null = null;
  let lastFocus: HTMLElement | null = null;
  let disposeGoogle: (() => void) | undefined;
  let disposeGithub: (() => void) | undefined;
  let githubInProgress = false;
  let githubControls: { control: HTMLInputElement | HTMLButtonElement; disabled: boolean }[] = [];
  const githubResult = authPage ? consumeGithubResult() : null;

  const billingPanel = q('[data-stripe-billing]');
  const stripeBilling = billingPanel ? mountStripeBilling(billingPanel, {
    request: api, refreshAccounting: refreshStripe, preferredPlan,
    canInteract: () => signedIn && ready && !signingOut && !leavingPage,
  }) : null;
  if (view === 'billing') {
    const link = q<HTMLAnchorElement>('[data-login-link]');
    if (link) link.href = '/login?view=billing' + (preferredPlan ? '&plan=' + preferredPlan : '');
  }
  if (authPage && authDestination === billingPath) {
    const switchLink = q<HTMLAnchorElement>('.pp-auth-switch');
    if (switchLink) switchLink.search = 'view=billing' + (preferredPlan ? '&plan=' + preferredPlan : '');
    qa<HTMLAnchorElement>('[data-auth-existing] a[href="/app"], [data-signup-stage="2"] a[href="/app"]').forEach(link => { link.href = billingPath; });
    const finish = q<HTMLAnchorElement>('[data-finish-signup]');
    if (finish) { finish.href = billingPath; finish.textContent = 'Review project billing'; }
  }

  // ---------- small helpers ----------
  function textAll(selector: string, value: unknown) { qa(selector).forEach(node => { node.textContent = String(value ?? '—'); }); }
  const hide = (selector: string, hidden: boolean) => qa(selector).forEach(node => { node.hidden = hidden; });
  function setError(error: unknown, selector = '[data-page-error]') {
    const message = error instanceof Error ? error.message : String(error || 'The request could not be completed.');
    const node = q(selector);
    if (node) { node.textContent = message.slice(0, 1000); node.hidden = !message; }
  }
  function clearError(selector = '[data-page-error]') { const node = q(selector); if (node) { node.textContent = ''; node.hidden = true; } }
  function toast(message: string) {
    const node = q('[data-toast]'); if (!node) return;
    clearTimeout(toastTimer); node.textContent = message; node.hidden = false;
    toastTimer = setTimeout(() => { node.hidden = true; }, 5000);
  }
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', value = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = value; return node;
  };
  function selectedId() { try { const id = sessionStorage.getItem(selectedStorage); return validProject(id) ? id : ''; } catch { return ''; } }
  function saveProject(id: string) { try { sessionStorage.setItem(selectedStorage, id); } catch { /* optional preference */ } }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast('Copied to clipboard.'); }
    catch { toast('Clipboard unavailable. Select and copy the text.'); }
  }
  function download(blob: Blob, filename: string) {
    const href = URL.createObjectURL(blob), anchor = element('a');
    anchor.href = href; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1_000);
  }
  function base64Bytes(encoded: string) {
    const raw = atob(encoded), bytes = new Uint8Array(raw.length);
    for (let index = 0; index < bytes.length; index++) bytes[index] = raw.charCodeAt(index);
    return bytes;
  }

  async function api(path: string, options: { method?: string; body?: Json; timeout?: number; result?: boolean } = {}): Promise<Json> {
    const method = options.method || 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout ?? 20_000);
    try {
      const response = await fetch('/api/control' + path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
      let body: Json;
      try { body = await response.json(); } catch { throw new ControlError('The service returned an unreadable response.', 'invalid_response', response.status); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ControlError('The service returned an invalid response.', 'invalid_response', response.status);
      if (path === '/status' && body.enabled === false) return body;
      if (!response.ok) throw new ControlError(body.error?.message || 'The service could not complete this action.', body.error?.code || 'control_error', response.status, body);
      return body;
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError(controller.signal.aborted
        ? options.result ? 'Still running. Open Requests to see the result when it finishes.' : 'The service took too long to answer. Try again.'
        : 'Unable to reach FetchX. Check your connection and try again.', controller.signal.aborted ? 'timeout' : 'network_error');
    } finally { clearTimeout(timer); }
  }
  async function busy(form: HTMLFormElement, action: () => Promise<void>, errorSelector = '[data-page-error]') {
    if (form.dataset.busy) return;
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select'),
      ...(authPage ? qa<HTMLButtonElement>('[data-github-start],[data-github-connect]') : [])];
    const disabled = controls.map(control => control.disabled);
    mutating++;
    form.dataset.busy = 'true'; form.setAttribute('aria-busy', 'true'); controls.forEach(control => { control.disabled = true; }); clearError(errorSelector);
    try { await action(); } catch (error) { setError(error, errorSelector); }
    finally {
      mutating--; delete form.dataset.busy; form.removeAttribute('aria-busy');
      controls.forEach((control, index) => { control.disabled = disabled[index]; }); updateRunButton();
    }
  }
  function onForm(selector: string, action: (form: HTMLFormElement, values: FormData) => Promise<void>, errorSelector?: string) {
    q<HTMLFormElement>(selector)?.addEventListener('submit', event => {
      event.preventDefault();
      if (authPage && mutating) return;
      const form = event.currentTarget as HTMLFormElement;
      // Read the values before busy() disables the controls: disabled fields are left out of FormData.
      const values = new FormData(form);
      void busy(form, () => action(form, values), errorSelector);
    });
  }
  function confirmAction(title: string, description: string, action: string, callback: () => void) {
    lastFocus = document.activeElement as HTMLElement;
    textAll('#confirm-title', title); textAll('[data-confirm-description]', description); textAll('[data-confirm-action]', action);
    confirmCallback = callback; q<HTMLDialogElement>('[data-confirm-dialog]')?.showModal();
  }
  q<HTMLDialogElement>('[data-confirm-dialog]')?.addEventListener('close', event => {
    const dialog = event.currentTarget as HTMLDialogElement, callback = confirmCallback;
    confirmCallback = null;
    if (dialog.returnValue === 'confirm') callback?.(); else lastFocus?.focus();
    dialog.returnValue = '';
  });

  // ---------- sign-in ----------
  function concealSecret() { revealedSecret = ''; textAll('[data-key-secret],[data-signup-secret]', 'Concealed'); }
  function showSecret(token: unknown) {
    concealSecret();
    if (typeof token !== 'string' || !/^fxk_[A-Za-z0-9_-]+$/.test(token)) throw new ControlError('The key was created, but its secret was not returned. Rotate it to get a new secret.', 'key_secret_unavailable');
    revealedSecret = token;
    if (authPage) {
      textAll('[data-signup-secret]', token); q('[data-signup-reveal]')!.hidden = false; q('[data-signup-key]')!.hidden = true; q('[data-finish-signup]')!.hidden = false;
    } else {
      textAll('[data-key-secret]', token); lastFocus = document.activeElement as HTMLElement; q<HTMLDialogElement>('[data-key-dialog]')?.showModal();
    }
  }
  function stage(index: number) {
    qa('[data-signup-stage]').forEach(node => { node.hidden = Number(node.dataset.signupStage) !== index; });
    qa('[data-signup-progress]').forEach(node => {
      node.classList.toggle('is-current', Number(node.dataset.signupProgress) === index);
      node.classList.toggle('is-complete', Number(node.dataset.signupProgress) < index);
    });
    q(`[data-signup-stage="${index}"] input`)?.focus();
  }
  function scopes(values: FormData) {
    const selected = values.getAll('scope').map(String);
    if (!selected.length) throw new ControlError('Choose at least one permission.', 'scopes_required');
    return selected;
  }
  function acceptSession(data: Json) {
    csrf = String(data.csrf_token || ''); projects = Array.isArray(data.projects) ? data.projects : []; signedIn = true;
    textAll('[data-user-email]', data.user?.email || 'Verified account');
    qa('[data-logout],[data-session-account],[data-auth-account]').forEach(node => { node.hidden = false; });
    const account = q('[data-github-account]'), connected = data.auth_methods?.github === true;
    if (authPage && account && (service.github?.enabled === true || connected)) {
      account.hidden = false;
      q('[data-github-connected]')!.hidden = !connected; q('[data-github-connect]')!.hidden = connected;
      disposeGithub?.(); disposeGithub = connected ? undefined : mountGithubSignIn({ container: account, mode: 'link', request: githubRequest, setBusy: setGithubBusy });
    }
  }
  function finishSignIn(data: Json) {
    disposeGoogle?.(); disposeGoogle = undefined; disposeGithub?.(); disposeGithub = undefined;
    acceptSession(data); email = ''; challenge = ''; clearError();
    const code = q<HTMLInputElement>('[data-signup-verify] input'); if (code) code.value = '';
    if (resumeConnect()) return;
    if (readConnectReturn()?.purpose === 'create') { stage(2); return; }
    if (projects.length && githubResult?.connectRequired) {
      showExistingAccount(); toast('Signed in. Choose Connect GitHub to connect this account.');
      requestAnimationFrame(() => q('[data-github-connect]')?.focus());
    } else if (projects.length) window.location.assign(authDestination);
    else stage(2);
  }
  function resumeConnect(projectCreated = false): boolean {
    const intent = readConnectReturn();
    if (!intent || intent.purpose === 'create' && !projectCreated && !projects.some(item => item.status === 'active')) return false;
    clearConnectReturn(); window.location.replace(intent.href); return true;
  }
  function showExistingAccount() {
    qa('[data-signup-stage]').forEach(node => { node.hidden = true; });
    q('[data-auth-existing]')!.hidden = false; q('[data-auth-progress]')?.setAttribute('hidden', '');
  }
  async function googleRequest(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (path !== '/auth/google/verify') return api(path, { method: 'POST', body });
    if (mutating || signedIn) throw new ControlError('A sign-in is already in progress.', 'auth_in_progress');
    const controls = qa<HTMLInputElement | HTMLButtonElement>('[data-signup-email] input,[data-signup-email] button,[data-signup-verify] input,[data-signup-verify] button,[data-resend-code],[data-change-email],[data-github-start]');
    const disabled = controls.map(control => control.disabled);
    mutating++; controls.forEach(control => { control.disabled = true; });
    try { return await api(path, { method: 'POST', body }); }
    finally { mutating--; controls.forEach((control, index) => { control.disabled = disabled[index]; }); }
  }
  function setGithubBusy(isBusy: boolean): boolean {
    if (isBusy) {
      if (mutating || signingOut || githubInProgress) return false;
      githubInProgress = true; mutating++;
      disposeGoogle?.(); disposeGoogle = undefined;
      githubControls = qa<HTMLInputElement | HTMLButtonElement>('form input,form button,[data-resend-code],[data-change-email],[data-logout],[data-github-start],[data-github-connect]')
        .map(control => ({ control, disabled: control.disabled }));
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
  const githubRequest = (path: string, body: Record<string, unknown>) => api(path, { method: 'POST', body });
  function enableGoogle() {
    const google = service.google, container = q('[data-google-signin]');
    if (google?.enabled === true && typeof google.client_id === 'string' && container && !disposeGoogle) {
      disposeGoogle = mountGoogleSignIn({ container, clientId: google.client_id, request: googleRequest, onSession: finishSignIn });
    }
  }
  const mailHelp = (text: string) => service.mail_delivery === 'local_private_mailbox' ? 'Local mode: no email is sent. Use the code from the local test mailbox.' : text;
  onForm('[data-signup-email]', async (_form, values) => {
    email = String(values.get('email') || '').trim();
    const data = await api('/auth/code', { method: 'POST', body: { email } });
    challenge = data.challenge_id;
    if (!challenge) throw new ControlError('The verification challenge was not returned.', 'invalid_response');
    textAll('[data-verification-help]', mailHelp(`Use the eight-digit code sent to ${email}.`)); stage(1);
  });
  onForm('[data-signup-verify]', async (_form, values) => {
    finishSignIn(await api('/auth/verify', { method: 'POST', body: { email, challenge_id: challenge, code: String(values.get('code') || '') } }));
  });
  q('[data-resend-code]')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true; clearError();
    try { challenge = (await api('/auth/code', { method: 'POST', body: { email } })).challenge_id; toast(mailHelp('Use the new code from your email.')); }
    catch (error) { setError(error); } finally { button.disabled = false; }
  });
  q('[data-change-email]')?.addEventListener('click', () => { challenge = ''; clearError(); stage(0); });
  onForm('[data-signup-project]', async (_form, values) => {
    const data = await api('/projects', { method: 'POST', body: { name: String(values.get('project') || '').trim() } });
    project = data.project;
    if (!project || !validProject(project.id)) throw new ControlError('The service did not return the new project.', 'invalid_response');
    if (resumeConnect(true)) return;
    saveProject(project.id); textAll('[data-project-name]', project.name); stage(3);
  });
  onForm('[data-signup-key]', async (_form, values) => {
    showSecret((await api(projectPath('/keys'), { method: 'POST', body: { name: String(values.get('name') || '').trim(), scopes: scopes(values) } })).token);
  });
  q('[data-signup-copy]')?.addEventListener('click', () => { if (revealedSecret) void copy(revealedSecret); });
  q('[data-conceal-signup-key]')?.addEventListener('click', () => { concealSecret(); q<HTMLButtonElement>('[data-signup-copy]')!.disabled = true; });
  qa('[data-logout]').forEach(button => button.addEventListener('click', async () => {
    if (signingOut || githubInProgress) return;
    signingOut = true; stripeBilling?.reset(); clearError();
    const buttons = qa<HTMLButtonElement>('[data-logout]');
    buttons.forEach(node => { node.disabled = true; node.textContent = 'Signing out…'; });
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
      concealSecret(); csrf = ''; signedIn = false;
      try { sessionStorage.removeItem(selectedStorage); } catch { /* nothing stored */ }
      window.location.assign('/login');
    } catch (error) {
      setError(error); signingOut = false;
      buttons.forEach(node => { node.disabled = false; node.textContent = 'Sign out'; });
      if (project && ready) stripeBilling?.setProject(project.id, billing?.stripe);
    }
  }));

  // ---------- projects ----------
  function projectPath(path = '') {
    if (!project) throw new ControlError('Select a project first.', 'project_required');
    return '/projects/' + encodeURIComponent(project.id) + path;
  }
  function setProjectOptions() {
    const select = q<HTMLSelectElement>('[data-project-select]'); if (!select) return;
    select.replaceChildren();
    if (!projects.length) select.append(new Option('No projects yet', ''));
    projects.forEach(item => select.append(new Option(item.name, item.id)));
    select.disabled = !projects.length;
    if (project) select.value = project.id;
    qa<HTMLButtonElement>('[data-open-project]').forEach(button => { button.disabled = !signedIn; });
  }
  function gate(title: string, description: string, action: 'login' | 'project' | '' = '') {
    q('[data-workspace-content]')?.setAttribute('hidden', ''); q('[data-workspace-gate]')?.removeAttribute('hidden');
    textAll('[data-gate-title]', title); textAll('[data-gate-description]', description);
    const login = q('[data-login-link]'); if (login) login.hidden = action !== 'login';
    const create = q('[data-workspace-gate] [data-open-project]'); if (create) create.hidden = action !== 'project';
  }
  qa('[data-open-project]').forEach(button => button.addEventListener('click', () => {
    if (!signedIn) return;
    lastFocus = document.activeElement as HTMLElement;
    q<HTMLDialogElement>('[data-project-dialog]')?.showModal(); q<HTMLInputElement>('[data-create-project] input')?.focus();
  }));
  q('[data-close-project]')?.addEventListener('click', () => q<HTMLDialogElement>('[data-project-dialog]')?.close());
  onForm('[data-create-project]', async (form, values) => {
    const data = await api('/projects', { method: 'POST', body: { name: String(values.get('name') || '').trim() } });
    projects.push(data.project); setProjectOptions(); q<HTMLDialogElement>('[data-project-dialog]')?.close(); form.reset();
    await selectProject(data.project.id, true);
  }, '[data-project-error]');
  q<HTMLSelectElement>('[data-project-select]')?.addEventListener('change', event => { void selectProject((event.currentTarget as HTMLSelectElement).value); });

  async function selectProject(id: string, created = false) {
    const selected = projects.find(item => item.id === id);
    if (!selected || signingOut) return;
    if (sending || (mutating && !created)) {
      toast('Wait for the current action to finish before switching projects.');
      const select = q<HTMLSelectElement>('[data-project-select]'); if (select && project) select.value = project.id;
      return;
    }
    const version = ++loadVersion;
    project = selected; ready = false; usage = billing = null; currentResult = null;
    stripeBilling?.reset(); concealSecret(); q<HTMLDialogElement>('[data-key-dialog]')?.close(); q<HTMLDialogElement>('[data-request-dialog]')?.close();
    saveProject(id); setProjectOptions(); clearError(); renderBalance(true); renderResult(null);
    gate('Loading project…', 'Reading keys, requests and credits.'); textAll('[data-project-name]', selected.name);
    const [detail, keyList, history, usageReport, billingReport] = await Promise.allSettled([api(projectPath()), api(projectPath('/keys')),
      api(projectPath('/fetch' + historyQuery())), api(projectPath('/usage')), api(projectPath('/billing'))]);
    if (version !== loadVersion || signingOut || leavingPage) return;
    if (detail.status !== 'fulfilled') { renderBalance(); gate('Project unavailable', 'FetchX could not load this project. Refresh to try again.'); setError(detail.reason); return; }
    project = detail.value.project;
    keys = keyList.status === 'fulfilled' ? keyList.value.keys || [] : [];
    requests = history.status === 'fulfilled' ? history.value.items || [] : [];
    nextCursor = history.status === 'fulfilled' ? history.value.next_cursor ?? null : null;
    usage = usageReport.status === 'fulfilled' ? usageReport.value : null;
    billing = billingReport.status === 'fulfilled' ? billingReport.value : null;
    const failed = [keyList, history, usageReport, billingReport].filter(item => item.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length) setError('Some project data could not be loaded: ' + failed.map(item => item.reason?.message).join(' '));
    ready = true;
    renderBalance(); renderUsage(); renderKeys(); renderRequests(); renderChecklist(); renderCode();
    stripeBilling?.setProject(id, billing?.stripe);
    hide('[data-stripe-unavailable]', !!billing?.stripe);
    q('[data-workspace-gate]')!.hidden = true; q('[data-workspace-content]')!.hidden = false; updateRunButton();
  }
  async function refreshCredits() {
    const version = loadVersion;
    const [usageReport, billingReport] = await Promise.allSettled([api(projectPath('/usage')), api(projectPath('/billing'))]);
    if (version !== loadVersion) return;
    if (usageReport.status === 'fulfilled') usage = usageReport.value;
    if (billingReport.status === 'fulfilled') billing = billingReport.value;
    renderBalance(); renderUsage();
  }
  async function refreshStripe(id: string) {
    if (id !== project?.id) return null;
    await refreshCredits();
    return billing?.stripe ?? null;
  }

  // ---------- credits ----------
  function renderBalance(loading = false) {
    const balance = billing?.balance;
    const state = loading ? 'loading' : !balance ? 'unavailable' : balance.held ? 'held' : 'available';
    qa('[data-credit-summary]').forEach(node => { node.dataset.creditSummary = state; });
    textAll('[data-credit-total]', { loading: 'Loading…', unavailable: 'Unavailable', held: 'On hold', available: formatCredits(balance?.available) }[state]);
    hide('[data-credit-breakdown]', !balance);
    textAll('[data-credit-trial]', formatCredits(balance?.trial));
    textAll('[data-credit-purchased]', formatCredits(balance?.purchased));
    textAll('[data-credit-reserved]', formatCredits(balance?.reserved));
    hide('[data-credit-hold]', state !== 'held');
  }
  function renderUsage() {
    const used = usage?.used;
    textAll('[data-usage-credits]', number(used?.credits));
    textAll('[data-usage-succeeded]', number(used?.succeeded));
    textAll('[data-usage-failed]', number(used?.failed));
    textAll('[data-usage-captcha]', number(used?.captcha_solved));
    const steps = q('[data-usage-steps]');
    if (steps) {
      steps.replaceChildren();
      const rows = Array.isArray(usage?.by_step) ? usage!.by_step : [];
      if (!rows.length) steps.append(element('p', 'pp-live-empty', 'No credits used this month.'));
      else {
        const table = element('table', 'pp-request-table'), head = element('tr'), body = element('tbody');
        ['Step', 'Requests', 'Credits'].forEach(label => { const th = element('th', '', label); th.scope = 'col'; head.append(th); });
        table.append(element('thead'), body); table.tHead!.append(head);
        rows.forEach((row: Json) => {
          const tr = element('tr');
          tr.append(element('td', '', STEP_LABELS[row.step] ?? row.step), element('td', '', number(row.requests)), element('td', '', formatCredits(row.credits)));
          body.append(tr);
        });
        steps.append(table);
      }
    }
    const prices = q('[data-price-list]');
    if (prices && billing?.prices) {
      prices.replaceChildren();
      for (const [step, label] of Object.entries(PRICE_LABELS)) {
        const credits = billing.prices[step];
        if (typeof credits !== 'number') continue;
        const row = element('div'); row.append(element('dt', '', label), element('dd', '', formatCredits(credits))); prices.append(row);
      }
    }
  }

  // ---------- keys ----------
  onForm('[data-create-key]', async (form, values) => {
    showSecret((await api(projectPath('/keys'), { method: 'POST', body: { name: String(values.get('name') || '').trim(), scopes: scopes(values) } })).token);
    form.reset(); await refreshKeys();
  });
  q('[data-copy-key]')?.addEventListener('click', () => { if (revealedSecret) void copy(revealedSecret); });
  q('[data-close-key]')?.addEventListener('click', () => { concealSecret(); q<HTMLDialogElement>('[data-key-dialog]')?.close(); });
  q<HTMLDialogElement>('[data-key-dialog]')?.addEventListener('close', () => { concealSecret(); lastFocus?.focus(); });
  q<HTMLDialogElement>('[data-key-dialog]')?.addEventListener('cancel', concealSecret);
  async function refreshKeys() {
    const id = project?.id, data = await api(projectPath('/keys'));
    if (id !== project?.id) return;
    keys = data.keys || []; renderKeys(); renderChecklist();
  }
  function renderKeys() {
    const parent = q('[data-key-list]'); if (!parent) return;
    parent.replaceChildren();
    if (!keys.length) { parent.append(element('p', 'pp-live-empty', 'No keys yet. Create one for your server.')); return; }
    for (const key of keys) {
      const row = element('div', 'pp-key-row'), identity = element('div', 'pp-key-identity');
      identity.append(element('strong', '', key.name || 'API key'), element('code', '', key.id), element('small', '', `Created ${date(key.created_at)} · ${(key.scopes || []).join(', ')}`));
      const revoked = Boolean(key.revoked_at);
      row.append(identity, element('span', 'pp-status ' + (revoked ? 'pp-status-failed' : 'pp-status-completed'), revoked ? 'Revoked' : 'Active'));
      if (!revoked) {
        const actions = element('div', 'pp-key-actions');
        for (const action of ['rotate', 'revoke'] as const) {
          const button = element('button', 'pp-button pp-button-secondary', action === 'rotate' ? 'Rotate' : 'Revoke');
          button.type = 'button';
          button.addEventListener('click', () => confirmAction(
            action === 'rotate' ? 'Rotate this API key?' : 'Revoke this API key?',
            action === 'rotate' ? 'The old key stops working now. Save the new secret when it appears.' : 'This key stops working now. Applications using it need another key.',
            action === 'rotate' ? 'Rotate key' : 'Revoke key',
            () => void (async () => {
              button.disabled = true; mutating++; clearError();
              try {
                const data = await api(projectPath('/keys/' + encodeURIComponent(key.id) + (action === 'rotate' ? '/rotate' : '')),
                  { method: action === 'rotate' ? 'POST' : 'DELETE', ...(action === 'rotate' ? { body: {} } : {}) });
                if (action === 'rotate') showSecret(data.token);
                await refreshKeys();
              } catch (error) { setError(error); button.disabled = false; } finally { mutating--; updateRunButton(); }
            })()));
          actions.append(button);
        }
        row.append(actions);
      }
      parent.append(row);
    }
  }
  function renderChecklist() {
    const states = [signedIn, Boolean(project), keys.some(key => !key.revoked_at), requests.length > 0];
    textAll('[data-onboarding-count]', `${states.filter(Boolean).length} of 4 complete`);
    ['email', 'project', 'key', 'request'].forEach((name, index) => {
      const node = q(`[data-checklist-${name}]`);
      node?.classList.toggle('is-complete', states[index]);
      const mark = node?.querySelector('.pp-step-check'); if (mark) mark.textContent = states[index] ? '✓' : String(index + 1);
    });
  }

  // ---------- request history ----------
  function historyQuery(cursor?: string) {
    const params = new URLSearchParams({ limit: view === 'overview' ? '5' : '25' });
    const status = q<HTMLSelectElement>('[data-request-filter]')?.value, tag = q<HTMLInputElement>('[data-request-tag]')?.value.trim();
    if (status) params.set('status', status);
    if (tag) params.set('tag', tag);
    if (cursor) params.set('cursor', cursor);
    return '?' + params;
  }
  async function refreshHistory(more = false) {
    const version = loadVersion, data = await api(projectPath('/fetch' + historyQuery(more ? nextCursor ?? undefined : undefined)));
    if (version !== loadVersion) return;
    requests = more ? [...requests, ...(data.items || [])] : data.items || [];
    nextCursor = data.next_cursor ?? null;
    renderRequests(); renderChecklist();
  }
  const statusClass = (status: string) => 'pp-status pp-status-' + ({ succeeded: 'completed', failed: 'failed', pending: 'running' }[status] ?? 'unknown');
  function renderRequests() {
    textAll('[data-filter-count]', `${requests.length} ${requests.length === 1 ? 'request' : 'requests'}`);
    hide('[data-more-requests]', !nextCursor);
    qa('[data-request-list]').forEach(parent => {
      parent.replaceChildren();
      const rows = requests.slice(0, Number(parent.dataset.requestLimit) || requests.length);
      if (!rows.length) {
        const empty = element('div', 'pp-log-empty');
        empty.append(element('h3', '', 'No requests yet.'), element('p', '', 'Fetch a URL in the playground or with an API key.'));
        parent.append(empty); return;
      }
      const scroll = element('div', 'pp-table-scroll'), table = element('table', 'pp-request-table'), head = element('tr'), body = element('tbody');
      ['URL', 'Status', 'Credits', 'Created'].forEach(label => { const th = element('th', '', label); th.scope = 'col'; head.append(th); });
      table.append(element('thead'), body); table.tHead!.append(head);
      for (const item of rows) {
        const row = element('tr'), cell = element('td'), link = element('button', 'pp-request-link', item.url);
        link.type = 'button'; link.title = item.id; link.addEventListener('click', () => void openRequest(item.id)); cell.append(link);
        const status = element('td'); status.append(element('span', statusClass(item.status), item.error_code ? `${item.status} · ${item.error_code}` : item.status));
        row.append(cell, status, element('td', '', formatCredits(item.credits?.charged)), element('td', '', date(item.created_at)));
        body.append(row);
      }
      scroll.append(table); parent.append(scroll);
    });
  }
  // Never insert remote HTML: the body is shown as text, capped.
  function preview(result: Json) {
    const data = result.data ? { ...result.data } : null;
    for (const field of ['body', 'markdown', 'text']) {
      if (typeof data?.[field] === 'string' && data[field].length > 20_000) data[field] = data[field].slice(0, 20_000) + `\n[${data[field].length - 20_000} more characters]`;
    }
    if (data?.screenshot) data.screenshot = '[base64 JPEG, see the Screenshot tab]';
    return JSON.stringify({ ...result, data }, null, 2);
  }
  async function openRequest(id: string) {
    const originalProject = project?.id, dialog = q<HTMLDialogElement>('[data-request-dialog]');
    if (!dialog) return;
    lastFocus = document.activeElement as HTMLElement;
    textAll('[data-request-detail]', 'Loading…'); textAll('[data-request-detail-status]', 'Reading the stored result. Nothing is sent to the site.');
    dialog.showModal();
    try {
      const result = await api(projectPath('/fetch/' + encodeURIComponent(id)));
      if (originalProject !== project?.id || !dialog.open) return;
      textAll('[data-request-detail]', preview(result));
      textAll('[data-request-detail-status]', result.error ? `${result.status}: ${result.error.message} ${result.error.next?.detail ?? ''}` : `${result.status}, ${formatCredits(result.credits?.charged)} credits.`);
    } catch (error) { if (dialog.open) textAll('[data-request-detail]', error instanceof Error ? error.message : String(error)); }
  }
  q('[data-close-request]')?.addEventListener('click', () => q<HTMLDialogElement>('[data-request-dialog]')?.close());
  q<HTMLDialogElement>('[data-request-dialog]')?.addEventListener('close', () => { textAll('[data-request-detail]', ''); lastFocus?.focus(); });
  q('[data-request-filter]')?.addEventListener('change', () => void refreshHistory().catch(setError));
  let tagTimer: ReturnType<typeof setTimeout>;
  q('[data-request-tag]')?.addEventListener('input', () => { clearTimeout(tagTimer); tagTimer = setTimeout(() => void refreshHistory().catch(setError), 300); });
  q('[data-more-requests]')?.addEventListener('click', () => void refreshHistory(true).catch(setError));
  q('[data-refresh-history]')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true; clearError();
    try { await refreshHistory(); } catch (error) { setError(error); } finally { button.disabled = false; }
  });

  // ---------- playground ----------
  const requestForm = q<HTMLFormElement>('[data-playground-form]');
  function requestBody(values = requestForm ? new FormData(requestForm) : null): Json | null {
    if (!values) return null;
    const url = String(values.get('url') || '').trim();
    if (!url) return null;
    const body: Json = { url };
    const render = String(values.get('render') || 'auto'); if (render !== 'auto') body.render = render;
    const formats = values.getAll('formats').map(String); if (formats.length) body.formats = formats;
    const country = String(values.get('country') || '').trim().toUpperCase();
    const route = String(values.get('route') || '');
    if (route) body.route = { class: route, country: route === 'direct' ? null : country || 'US', ...(render === 'always' ? { render: true } : {}) };
    else if (country) body.country = country;
    const selector = String(values.get('wait_selector') || '').trim(); if (selector) body.wait_for = { selector };
    const maxCredits = Number(values.get('max_credits')); if (Number.isSafeInteger(maxCredits) && maxCredits > 0) body.max_credits = maxCredits;
    const maxAttempts = Number(values.get('max_attempts')); if (Number.isSafeInteger(maxAttempts) && maxAttempts > 0) body.max_attempts = maxAttempts;
    if (!values.get('fix_headers')) body.fix_headers = false;
    return body;
  }
  function updateRunButton() {
    const button = q<HTMLButtonElement>('[data-run-request]'); if (!button) return;
    const held = billing?.balance?.held === true;
    button.disabled = !ready || sending || mutating > 0 || signingOut || held || !requestForm?.checkValidity();
    button.textContent = sending ? 'Fetching…' : 'Fetch';
  }
  function renderCode() {
    const body = requestBody(), language = q<HTMLSelectElement>('[data-code-language]')?.value || 'curl';
    textAll('[data-generated-code]', body ? requestCode(service.api_base_url || 'https://YOUR_FETCHX_API', language, body) : 'Enter a URL to see the code for this request.');
  }
  requestForm?.addEventListener('input', () => { updateRunButton(); renderCode(); });
  requestForm?.addEventListener('change', () => { updateRunButton(); renderCode(); });
  q('[data-code-language]')?.addEventListener('change', renderCode);
  q('[data-copy-code]')?.addEventListener('click', () => { const body = requestBody(); if (body) void copy(q('[data-generated-code]')!.textContent || ''); });
  onForm('[data-playground-form]', async (_form, values) => {
    const body = requestBody(values); if (!body || !project) return;
    const id = project.id;
    sending = true; updateRunButton(); renderResult(null, 'Fetching. FetchX may try several routes, up to a minute.');
    try {
      const result = await api(projectPath('/fetch'), { method: 'POST', body: { ...body, tags: ['console'] }, timeout: 75_000, result: true });
      if (id !== project?.id) return;
      renderResult(result);
      if (result.status === 'pending') toast('Still running. It will appear in Requests when it finishes.');
    } finally {
      sending = false; updateRunButton();
      if (id === project?.id) void Promise.allSettled([refreshCredits(), refreshHistory()]);
    }
  }, '[data-fetch-error]');

  function renderResult(result: Json | null, note = 'No request has been sent.') {
    currentResult = result;
    const badge = q('[data-response-state]');
    if (badge) { badge.className = result ? statusClass(result.status) : 'pp-status'; badge.textContent = result ? result.status : sending ? 'Fetching…' : 'Ready'; }
    const error = result?.error;
    textAll('[data-response-note]', result ? error ? `${error.message} ${error.next?.detail ?? ''}`.trim()
      : result.status === 'pending' ? 'Still running. Open Requests to see the result.' : `Got the data in ${result.attempts?.length ?? 0} ${result.attempts?.length === 1 ? 'attempt' : 'attempts'}.` : note);
    hide('[data-result-facts]', !result);
    textAll('[data-result-status]', result?.data?.status_code ?? '—');
    textAll('[data-result-credits]', result ? formatCredits(result.credits?.charged ?? 0) : '—');
    textAll('[data-result-attempts]', result ? number(result.attempts?.length ?? 0) : '—');
    textAll('[data-result-rendered]', result?.data ? (result.data.rendered ? 'Yes' : 'No') : '—');
    const attempts = q('[data-attempt-list]');
    if (attempts) {
      attempts.replaceChildren();
      if (result?.attempts?.length) {
        const list = element('ol', 'pp-attempts');
        for (const attempt of result.attempts) {
          const route = `${attempt.transport === 'browser' ? 'Browser' : 'HTTP'} · ${attempt.class}${attempt.country ? ' ' + attempt.country : ''}${attempt.rotation ? ' · fresh IP' : ''}`;
          list.append(element('li', '', `${route}: ${attempt.result}${attempt.status_code ? ` (${attempt.status_code})` : ''}${attempt.captcha?.length ? ` · captcha ${attempt.captcha.join(', ')}` : ''}`));
        }
        attempts.append(list);
      }
    }
    const data = result?.data;
    const shown = typeof data?.markdown === 'string' ? ['Markdown', data.markdown] : typeof data?.text === 'string' ? ['Text', data.text]
      : typeof data?.body === 'string' ? [data.body_encoding === 'base64' ? 'Binary body (base64)' : 'Body', data.body] : null;
    textAll('[data-output-label]', shown ? shown[0] : 'Content');
    textAll('[data-response-output]', shown ? (shown[1].length > INLINE_TEXT_LIMIT ? shown[1].slice(0, INLINE_TEXT_LIMIT) + '\n[Truncated. Download the body for all of it.]' : shown[1])
      : result ? data?.content_expired ? 'The content has expired.' : 'No content.' : 'Fetch a URL to see its content.');
    hide('[data-copy-output]', !shown); hide('[data-download-body]', typeof data?.body !== 'string');
    textAll('[data-response-headers]', data?.headers ? JSON.stringify({ headers: data.headers, cookies: data.cookies ?? [] }, null, 2) : 'No headers yet.');
    textAll('[data-response-json]', result ? preview(result) : 'No response yet.');
    const shot = q<HTMLImageElement>('[data-browser-screenshot]');
    const hasShot = typeof data?.screenshot === 'string';
    if (shot) { if (hasShot) shot.src = 'data:image/jpeg;base64,' + data.screenshot; else shot.removeAttribute('src'); }
    const shotTab = q<HTMLButtonElement>('[data-inspector-tab="screenshot"]');
    if (shotTab) { shotTab.hidden = !hasShot; if (!hasShot && shotTab.getAttribute('aria-selected') === 'true') selectTab(tabs[0]); }
  }
  q('[data-copy-output]')?.addEventListener('click', () => {
    const data = currentResult?.data, text = data?.markdown ?? data?.text ?? (data?.body_encoding === 'utf-8' ? data.body : null);
    if (typeof text === 'string') void copy(text);
  });
  q('[data-download-body]')?.addEventListener('click', () => {
    const data = currentResult?.data; if (typeof data?.body !== 'string') return;
    const type = data.content_type || 'application/octet-stream';
    try { download(new Blob([data.body_encoding === 'base64' ? base64Bytes(data.body) : data.body], { type }), 'fetchx-body'); }
    catch { toast('The body could not be downloaded.'); }
  });
  const tabs = qa<HTMLButtonElement>('[data-inspector-tab]');
  function selectTab(button: HTMLButtonElement) {
    tabs.forEach(tab => { const selected = tab === button; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
    qa('[data-inspector-panel]').forEach(panel => { panel.hidden = panel.dataset.inspectorPanel !== button.dataset.inspectorTab; });
  }
  tabs.forEach(tab => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const visible = tabs.filter(item => !item.hidden), index = visible.indexOf(tab);
      const next = { ArrowRight: (index + 1) % visible.length, ArrowLeft: (index + visible.length - 1) % visible.length, Home: 0, End: visible.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault(); selectTab(visible[next]); visible[next].focus();
    });
  });

  // ---------- navigation ----------
  const menu = q<HTMLButtonElement>('[data-app-menu]'), menuClose = q<HTMLButtonElement>('[data-app-menu-close]'), sidebar = q('.pp-sidebar');
  function closeMenu(restoreFocus = true) {
    if (restoreFocus) menu?.focus();
    root.classList.remove('pp-menu-open'); menu?.setAttribute('aria-expanded', 'false');
    if (menuClose) menuClose.hidden = true;
  }
  menu?.addEventListener('click', () => {
    if (menu.getAttribute('aria-expanded') === 'true') { closeMenu(); return; }
    root.classList.add('pp-menu-open'); menu.setAttribute('aria-expanded', 'true');
    if (menuClose) { menuClose.hidden = false; menuClose.focus(); }
  });
  menuClose?.addEventListener('click', () => closeMenu());
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && root.classList.contains('pp-menu-open')) closeMenu(); });
  document.addEventListener('click', event => {
    if (!root.classList.contains('pp-menu-open') || (event.target as Element).closest('.pp-sidebar,[data-app-menu]')) return;
    const focused = document.activeElement;
    closeMenu(focused === document.body || sidebar?.contains(focused));
  });
  window.addEventListener('pagehide', () => {
    leavingPage = true; ++loadVersion; stripeBilling?.reset();
    disposeGoogle?.(); disposeGithub?.(); concealSecret();
    csrf = ''; email = ''; challenge = ''; currentResult = null; requestForm?.reset();
    q('[data-browser-screenshot]')?.removeAttribute('src');
    textAll('[data-response-output],[data-response-headers],[data-response-json],[data-request-detail],[data-generated-code]', '');
  });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  q('[data-refresh-workspace]')?.addEventListener('click', () => { if (!sending && !mutating && !signingOut) void start(); });

  async function start() {
    disposeGoogle?.(); disposeGoogle = undefined; disposeGithub?.(); disposeGithub = undefined;
    loadVersion++; ready = false; signedIn = false; csrf = ''; projects = []; project = null; usage = billing = null;
    stripeBilling?.reset(); concealSecret(); clearError();
    qa('[data-logout],[data-session-account],[data-auth-account]').forEach(node => { node.hidden = true; });
    setProjectOptions(); renderBalance(true); textAll('[data-user-email]', 'Not signed in');
    if (!authPage) gate('Opening your workspace…', 'Checking the service and your session.');
    try {
      service = await api('/status');
      if (!service.enabled) throw new ControlError('Accounts are not enabled on this service. Contact FetchX for access.', 'service_unavailable');
      textAll('[data-service-status]', service.mail_delivery === 'local_private_mailbox' ? 'Local mode · test mailbox'
        : service.mail_configured || service.google?.enabled || service.github?.enabled ? 'Connected' : 'Sign-in is not configured');
      textAll('[data-auth-delivery-help]', mailHelp('We’ll email a one-time code to verify your address.'));
      let session: Json | null = null;
      try { session = await api('/session'); } catch (error) { if (!(error instanceof ControlError) || error.status !== 401) throw error; }
      if (session) {
        acceptSession(session);
        if (resumeConnect()) return;
        if (authPage) {
          if (projects.length && readConnectReturn()?.purpose !== 'create') showExistingAccount(); else stage(2);
        } else {
          setProjectOptions();
          if (projects.length) await selectProject(projects.some(item => item.id === selectedId()) ? selectedId() : projects[0].id);
          else gate('Create your first project.', 'Your email is verified. Your first project gets the trial credits.', 'project');
        }
      } else if (authPage) {
        const google = service.google;
        if (!service.mail_configured && !google?.enabled && !service.github?.enabled) throw new ControlError('Sign-in is not configured. Contact FetchX.', 'auth_unconfigured');
        q<HTMLButtonElement>('[data-signup-email] button')!.disabled = !service.mail_configured;
        if (!service.mail_configured) textAll('[data-auth-delivery-help]', 'Email codes are unavailable right now. Choose another sign-in method above.');
        const githubContainer = q('[data-github-signin]');
        if (service.github?.enabled === true && githubContainer) disposeGithub = mountGithubSignIn({ container: githubContainer, mode: 'login', request: githubRequest, setBusy: setGithubBusy });
        const divider = q('[data-auth-divider]'); if (divider) divider.hidden = !google?.enabled && !service.github?.enabled;
        enableGoogle();
      } else {
        setProjectOptions(); gate('Sign in to continue.', 'Use GitHub, Google or a one-time email code.', 'login');
      }
      if (githubResult) { if (githubResult.success) { if (session?.auth_methods?.github === true) toast(githubResult.message); } else setError(githubResult.message); }
    } catch (error) {
      textAll('[data-service-status]', 'Service unavailable'); setError(error);
      if (!authPage) gate('Workspace unavailable.', 'FetchX could not be reached. Refresh to try again.');
    } finally {
      if (!project) renderBalance();
    }
  }
  await start();
}
