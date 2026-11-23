import { clearConnectReturn, connectLink, rememberConnectReturn, type ConnectLink } from './connect-return';

type Json = Record<string, unknown>;
type Project = { id: string; name: string; status: 'active' };
type Decision = 'approve' | 'deny';
type Limits = { credits_per_day: number | null; credits_per_month: number | null; expires_at: string | null };
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;
const projectPattern = /^cp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const codePattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const NEW_PROJECT = 'new';
const LIMIT_MAX = 100_000_000;
const noLimits: Limits = { credits_per_day: null, credits_per_month: null, expires_at: null };
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

// The review's limits; an older service sends none, which means no limits.
function limitsOf(value: unknown): Limits {
  if (value === undefined || value === null) return { ...noLimits };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid limits');
  const { credits_per_day: day, credits_per_month: month, expires_at: expires } = value as Record<string, unknown>;
  const amount = (v: unknown) => v === null || v === undefined ? null : Number.isSafeInteger(v) && (v as number) >= 1 ? v as number : NaN;
  const limits = { credits_per_day: amount(day), credits_per_month: amount(month),
    expires_at: expires === null || expires === undefined ? null : typeof expires === 'string' && Number.isFinite(Date.parse(expires)) ? expires : '' };
  if (Number.isNaN(limits.credits_per_day) || Number.isNaN(limits.credits_per_month) || limits.expires_at === '') throw new Error('Invalid limits');
  return limits as Limits;
}

function limitsText(limits: Limits): string {
  const parts: string[] = [];
  if (limits.credits_per_day) parts.push(`up to ${limits.credits_per_day.toLocaleString()} credits a day`);
  if (limits.credits_per_month) parts.push(`up to ${limits.credits_per_month.toLocaleString()} credits a month`);
  if (limits.expires_at) parts.push(`expires ${new Date(limits.expires_at).toLocaleString()}`);
  if (!parts.length) return 'No limits: the key can spend the project’s whole balance.';
  const text = parts.join(', ');
  return text[0].toUpperCase() + text.slice(1) + '.';
}

// A date-time input's value (local time) for an ISO time.
function localInput(value: string) {
  const at = new Date(value), pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function mountConnect(root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-connect-${name}]`)!;
  const status = q('status'), error = q('error'), account = q('account'), signIn = q('signin');
  const details = q('details'), review = q('review'), refresh = q<HTMLButtonElement>('refresh');
  const select = q<HTMLSelectElement>('project'), projectField = q('project-field'), code = q<HTMLInputElement>('code');
  const newProject = q('new-project'), projectName = q<HTMLInputElement>('project-name');
  const limitDay = q<HTMLInputElement>('limit-day'), limitMonth = q<HTMLInputElement>('limit-month'), limitExpires = q<HTMLInputElement>('limit-expires');
  const approve = q<HTMLButtonElement>('approve'), deny = q<HTMLButtonElement>('deny'), logout = q<HTMLButtonElement>('logout');
  const codeHelp = q('code-help'), codeHelpText = codeHelp.textContent ?? '';
  let link: ConnectLink | null = null, csrf = '', projects: Project[] = [], version = 0, busy = false;

  function showError(message = '') {
    error.textContent = message; error.hidden = !message;
  }

  const creating = () => !projects.length || select.value === NEW_PROJECT;

  function controls() {
    const hasCode = codePattern.test(code.value.trim().toUpperCase());
    const hasProject = creating() ? projectName.value.trim().length > 0 : projects.some(project => project.id === select.value);
    select.disabled = busy || !projects.length;
    projectName.disabled = busy;
    for (const input of [limitDay, limitMonth, limitExpires]) input.disabled = busy;
    code.disabled = busy;
    approve.disabled = busy || !hasCode || !hasProject;
    approve.textContent = creating() ? 'Create project and approve' : 'Approve connection';
    deny.disabled = busy || !hasCode;
    logout.disabled = busy;
    refresh.disabled = busy;
    newProject.hidden = !creating();
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

  // The code a verification_uri_complete link carried: shown, for the user to
  // check against their agent, instead of typed.
  function showCode(value: string | null) {
    codeHelp.textContent = codeHelpText;
    if (!value) return;
    code.value = value;
    codeHelp.replaceChildren('This code came with your link. Approve only if your agent shows ', Object.assign(document.createElement('strong'), { textContent: value }), '.');
  }

  function showLimits(limits: Limits, clientName: string) {
    q('limits-summary').textContent = limitsText(limits);
    limitDay.value = limits.credits_per_day ? String(limits.credits_per_day) : '';
    limitMonth.value = limits.credits_per_month ? String(limits.credits_per_month) : '';
    limitExpires.value = limits.expires_at ? localInput(limits.expires_at) : '';
    const asked = limits.credits_per_day || limits.credits_per_month || limits.expires_at;
    q('limits-help').textContent = asked
      ? `${clientName} asked for these. Change or clear them before approving; an empty field means no limit.`
      : 'Optional. Without limits the key can spend the project’s whole balance. An empty field means no limit.';
  }

  // The limits the user approves, as entered.
  function enteredLimits(): Limits {
    const amount = (input: HTMLInputElement, label: string) => {
      const raw = input.value.trim();
      if (!raw) return null;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 1 || value > LIMIT_MAX) throw new Error(`${label} must be a whole number from 1 to 100,000,000, or empty for no limit.`);
      return value;
    };
    const raw = limitExpires.value.trim(), at = raw ? new Date(raw) : null;
    if (at && (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now() + 60_000)) throw new Error('Choose an expiry in the future, or leave it empty.');
    return { credits_per_day: amount(limitDay, 'Credits per day'), credits_per_month: amount(limitMonth, 'Credits per month'), expires_at: at ? at.toISOString() : null };
  }

  async function load() {
    const current = ++version;
    link = connectLink(window.location.hash); csrf = ''; projects = [];
    code.value = ''; projectName.value = ''; select.replaceChildren(); account.hidden = true; signIn.hidden = true;
    details.hidden = true; review.hidden = true; refresh.hidden = true; showError();
    q('email').textContent = '';
    if (!link) {
      busy = false; controls();
      status.textContent = 'Open the approval link shown by your coding agent to review a connection.';
      return;
    }
    const id = link.requestId;
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
      const limits = limitsOf(result.limits);
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
      showLimits(limits, result.client_name);
      details.hidden = false;
      if (state !== 'pending') { showOutcome(state as keyof typeof outcomes); return; }
      if (projects.length) {
        select.append(new Option('Choose a project', ''));
        for (const project of projects) select.append(new Option(project.name, project.id));
        select.append(new Option('Create a new project', NEW_PROJECT));
      }
      projectField.hidden = !projects.length;
      projectName.value = result.client_name.slice(0, 80);
      q('project-name-help').textContent = projects.length
        ? 'Approving creates this project, and the key can use only it.'
        : 'You have no project yet. Approving creates this one, with your account’s trial credits, and the key can use only it.';
      showCode(link.code);
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
    if (busy || !link || !csrf || review.hidden) return;
    const userCode = code.value.trim().toUpperCase(), project = projects.find(item => item.id === select.value);
    const name = projectName.value.trim(), create = creating();
    if (!codePattern.test(userCode) || decision === 'approve' && (create ? !name : !project)) return;
    let limits: Limits | null = null;
    if (decision === 'approve') {
      try { limits = enteredLimits(); } catch (cause) { showError((cause as Error).message); return; }
    }
    const target = decision !== 'approve' ? {} : create ? { project_name: name } : { project_id: project!.id };
    const body = { request_id: link.requestId, user_code: userCode, decision, ...target, ...(limits ? { limits } : {}) };
    const outcome = decision === 'approve' ? 'approved' : 'denied';
    const current = version;
    busy = true; controls(); showError();
    status.textContent = decision === 'deny' ? 'Denying connection…' : create ? 'Creating the project and approving…' : 'Approving connection…';
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
        code.value = ''; showCode(null); showError('That code could not be verified. Check the code shown by your agent and try again. If it still fails, start a new request.');
      } else if (cause instanceof ConnectError && cause.code === 'key_limit') {
        code.value = ''; showError('This project has reached its key limit. Choose another project or free a key in your workspace.');
      } else if (cause instanceof ConnectError && cause.code === 'project_limit') {
        showError('Your account has reached its project limit. Choose an existing project.');
      } else if (cause instanceof ConnectError && cause.code === 'project_name_invalid') {
        showError('Give the project a name of up to 80 characters.');
      } else if (cause instanceof ConnectError && (cause.code === 'key_limits_invalid' || cause.code === 'key_expiry_invalid')) {
        showError('Check the key limits: whole numbers from 1 to 100,000,000, an expiry in the future at most 5 years away, or empty for no limit.');
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

  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('[data-connect-return]')) {
    anchor.addEventListener('click', event => {
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (rememberConnectReturn(link)) { anchor.removeAttribute('target'); return; }
      anchor.target = '_blank';
      status.textContent = 'Continue in the new tab, then return here and choose Check again.';
    });
  }
  document.querySelector<HTMLAnchorElement>('.skip-link')?.addEventListener('click', event => {
    const main = document.getElementById('main'); if (!main) return;
    event.preventDefault(); main.tabIndex = -1; main.focus();
  });
  select.addEventListener('change', () => { controls(); if (select.value === NEW_PROJECT) projectName.focus(); });
  projectName.addEventListener('input', controls);
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
