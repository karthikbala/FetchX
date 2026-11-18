import { clearConnectReturn, connectRequestId, rememberConnectReturn } from './connect-return';

type Json = Record<string, unknown>;
type Project = { id: string; name: string; status: 'active' };
type Decision = 'approve' | 'deny';
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const projectPattern = /^cp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const codePattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const unavailable = 'FetchX Connect is unavailable right now. Check again later.';
const outcomes = {
  approved: 'Connection approved. Return to your coding agent to finish connecting.',
  denied: 'Connection denied. The agent was not granted access.',
  connected: 'This request is connected. You can close this page.',
  expired: 'This connection request expired. Start a new request from your coding agent.',
};
const scopeDetails: Record<string, string> = {
  'fetch:read': 'Read fetch results',
  'fetch:write': 'Submit fetch requests',
  'usage:read': 'Read project usage',
  'profiles:read': 'Read access profiles',
};

class ConnectError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

async function api(path: string, body?: Json, csrf?: string): Promise<Json> {
  const headers = new Headers({ Accept: 'application/json' });
  if (body) headers.set('Content-Type', 'application/json');
  if (csrf) headers.set('X-CSRF-Token', csrf);
  const response = await fetch('/api/control' + path, {
    method: body ? 'POST' : 'GET', headers, credentials: 'same-origin', cache: 'no-store',
    redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15_000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid control response');
  if (path === '/status' && data.enabled === false) return data;
  if (!response.ok) throw new ConnectError(response.status, data.error?.code);
  return data;
}

function activeProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false;
  const project = value as Partial<Project>;
  return project.status === 'active' && typeof project.id === 'string' && projectPattern.test(project.id) && typeof project.name === 'string';
}

function mountConnect(root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-connect-${name}]`)!;
  const status = q('status'), error = q('error'), account = q('account'), signIn = q('signin');
  const details = q('details'), review = q('review'), refresh = q<HTMLButtonElement>('refresh');
  const select = q<HTMLSelectElement>('project'), code = q<HTMLInputElement>('code');
  const approve = q<HTMLButtonElement>('approve'), deny = q<HTMLButtonElement>('deny'), logout = q<HTMLButtonElement>('logout');
  let requestId: string | null = null, csrf = '', projects: Project[] = [], version = 0, busy = false;

  function showError(message = '') {
    error.textContent = message; error.hidden = !message;
  }

  function controls() {
    const hasCode = codePattern.test(code.value.trim().toUpperCase());
    select.disabled = busy || !projects.length;
    code.disabled = busy;
    approve.disabled = busy || !hasCode || !projects.some(project => project.id === select.value);
    deny.disabled = busy || !hasCode;
    logout.disabled = busy;
    refresh.disabled = busy;
    review.setAttribute('aria-busy', String(busy));
  }

  function showSignIn() {
    csrf = ''; code.value = ''; select.value = ''; account.hidden = true;
    q('email').textContent = ''; review.hidden = true; details.hidden = true;
    signIn.hidden = false; status.textContent = 'Sign in to FetchX to review this request.';
  }

  function showOutcome(state: keyof typeof outcomes) {
    code.value = ''; review.hidden = true; status.textContent = outcomes[state];
  }

  async function load() {
    const current = ++version;
    requestId = connectRequestId(window.location.hash); csrf = ''; projects = [];
    code.value = ''; select.replaceChildren(); account.hidden = true; signIn.hidden = true;
    details.hidden = true; review.hidden = true; refresh.hidden = true; showError();
    q('email').textContent = '';
    if (!requestId) {
      busy = false; controls();
      status.textContent = 'Open the approval link shown by your coding agent to review a connection.';
      return;
    }
    const id = requestId;
    busy = true; controls(); status.textContent = 'Checking your connection request…';
    try {
      const service = await api('/status');
      if (current !== version) return;
      if (service.connect_enabled !== true) { status.textContent = unavailable; return; }
      const session = await api('/session');
      if (current !== version) return;
      const user = session.user as { email?: unknown } | undefined;
      if (typeof user?.email !== 'string' || typeof session.csrf_token !== 'string' || !csrfPattern.test(session.csrf_token) || !Array.isArray(session.projects)) throw new Error('Invalid session');
      csrf = session.csrf_token;
      q('email').textContent = user.email; account.hidden = false;
      projects = session.projects.filter(activeProject);
      const result = await api('/connect/review', { request_id: id }, csrf);
      if (current !== version) return;
      if (typeof result.client_name !== 'string' || !Array.isArray(result.scopes) || !result.scopes.every(scope => typeof scope === 'string') ||
          typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at))) throw new Error('Invalid review');
      const state = result.state;
      if (typeof state !== 'string' || state !== 'pending' && !Object.hasOwn(outcomes, state)) throw new Error('Invalid connection state');
      q('client').textContent = result.client_name;
      const expires = q<HTMLTimeElement>('expires');
      expires.dateTime = result.expires_at; expires.textContent = new Date(result.expires_at).toLocaleString();
      const list = q('scopes'); list.replaceChildren();
      for (const scope of result.scopes) {
        const item = document.createElement('li'), label = document.createElement('code');
        label.textContent = scope; item.append(label);
        if (Object.hasOwn(scopeDetails, scope)) item.append(` — ${scopeDetails[scope]}`);
        list.append(item);
      }
      details.hidden = false;
      if (state !== 'pending') { showOutcome(state as keyof typeof outcomes); return; }
      select.append(new Option('Choose a project', ''));
      for (const project of projects) select.append(new Option(project.name, project.id));
      q('no-project').hidden = projects.length > 0; q('project-field').hidden = !projects.length;
      status.textContent = ''; review.hidden = false;
    } catch (cause) {
      if (current !== version) return;
      status.textContent = '';
      if (cause instanceof ConnectError && cause.status === 401) showSignIn();
      else if (cause instanceof ConnectError && cause.code === 'connect_not_found') status.textContent = 'This request could not be found for this account. Check the link from your coding agent.';
      else if (cause instanceof ConnectError && cause.code === 'connect_disabled') status.textContent = unavailable;
      else showError('Could not load the connection request. Check again to try loading it.');
    } finally {
      if (current === version) { busy = false; controls(); refresh.hidden = false; }
    }
  }

  async function decide(decision: Decision) {
    if (busy || !requestId || !csrf || review.hidden) return;
    const userCode = code.value.trim().toUpperCase(), project = projects.find(item => item.id === select.value);
    if (!codePattern.test(userCode) || decision === 'approve' && !project) return;
    const body = { request_id: requestId, user_code: userCode, decision, ...(decision === 'approve' && project ? { project_id: project.id } : {}) };
    const outcome = decision === 'approve' ? 'approved' : 'denied';
    const current = version;
    busy = true; controls(); showError(); status.textContent = decision === 'approve' ? 'Approving connection…' : 'Denying connection…';
    try {
      const result = await api('/connect/decision', body, csrf);
      if (current !== version) return;
      if (result.state !== outcome) throw new Error('Invalid connection decision');
      showOutcome(outcome); status.focus();
    } catch (cause) {
      if (current !== version) return;
      status.textContent = '';
      if (cause instanceof ConnectError && cause.status === 401) showSignIn();
      else if (cause instanceof ConnectError && cause.code === 'connect_code_invalid') {
        code.value = ''; showError('That code could not be verified. Check the code shown by your agent and try again. If it still fails, start a new request.');
      } else if (cause instanceof ConnectError && cause.code === 'key_limit') {
        code.value = ''; showError('This project has reached its key limit. Choose another project or free a key in your workspace.');
      } else if (cause instanceof ConnectError && ['connect_not_found', 'connect_request_closed', 'csrf_rejected', 'project_not_found', 'project_disabled', 'project_template_changed'].includes(cause.code)) {
        code.value = ''; review.hidden = true; showError('The request, account, or project has changed. Check again before deciding.');
      } else if (cause instanceof ConnectError && cause.code === 'connect_disabled') {
        code.value = ''; review.hidden = true; status.textContent = unavailable;
      } else {
        code.value = ''; review.hidden = true;
        showError('The decision could not be confirmed. Check the request status before trying again.');
      }
    } finally {
      if (current === version) { busy = false; controls(); if (!review.hidden && !code.value) code.focus(); }
    }
  }

  async function signOut() {
    if (busy || !csrf) return;
    const current = version;
    busy = true; code.value = ''; controls(); showError(); status.textContent = 'Signing out…';
    try {
      await api('/auth/logout', {}, csrf);
      if (current === version) showSignIn();
    } catch {
      if (current === version) { review.hidden = true; status.textContent = ''; showError('Sign-out could not be confirmed. Check again to verify your session.'); }
    } finally { if (current === version) { busy = false; controls(); } }
  }

  for (const link of root.querySelectorAll<HTMLAnchorElement>('[data-connect-return]')) {
    link.addEventListener('click', event => {
      if (!requestId || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const purpose = link.dataset.connectReturn === 'create' ? 'create' : 'review';
      if (rememberConnectReturn(requestId, purpose)) { link.removeAttribute('target'); return; }
      link.target = '_blank';
      status.textContent = 'Continue in the new tab, then return here and choose Check again.';
    });
  }
  document.querySelector<HTMLAnchorElement>('.skip-link')?.addEventListener('click', event => {
    const main = document.getElementById('main'); if (!main) return;
    event.preventDefault(); main.tabIndex = -1; main.focus();
  });
  select.addEventListener('change', controls);
  code.addEventListener('input', controls);
  approve.addEventListener('click', () => void decide('approve'));
  deny.addEventListener('click', () => void decide('deny'));
  logout.addEventListener('click', () => void signOut());
  refresh.addEventListener('click', () => { if (!busy) void load(); });
  window.addEventListener('hashchange', () => void load());
  window.addEventListener('pagehide', () => { version++; csrf = ''; code.value = ''; });
  window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
  clearConnectReturn();
  void load();
}

const root = document.querySelector<HTMLElement>('[data-connect]');
if (root) mountConnect(root);
