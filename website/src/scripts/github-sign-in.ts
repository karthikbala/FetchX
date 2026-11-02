// OAuth code, state and provider tokens are handled by the server callback only.
type Json = Record<string, unknown>;
const messages: Record<string, string> = {
  github_cancelled: 'GitHub sign-in was cancelled. Try again, or use another sign-in method.',
  github_account_link_required: 'An account already uses this email. Sign in with your existing method, then choose Connect GitHub.',
  github_email_verification_required: 'GitHub needs a verified primary email. Verify it in GitHub, then try again, or use another sign-in method.',
  github_identity_conflict: 'This GitHub account is connected to another FetchX account. Use your existing sign-in method.',
  github_session_conflict: 'Your session changed. Sign in to your existing account, then choose Connect GitHub again.',
  github_verification_invalid: 'GitHub sign-in expired or could not be verified. Choose Continue with GitHub to start again.',
  github_disabled: 'GitHub sign-in is unavailable right now. Use another sign-in method.',
  github_unavailable: 'GitHub sign-in could not be completed. Try again, or use another sign-in method.',
};
export function githubMessage(code: unknown): string { return typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : messages.github_unavailable; }

export function consumeGithubResult(): { message: string; success: boolean; connectRequired: boolean } | null {
  const url = new URL(window.location.href), result = url.searchParams.get('github');
  if (result === null) return null;
  // Only fixed messages are rendered. Remove all provider-result query data now.
  window.history.replaceState(window.history.state, '', url.pathname + url.hash);
  return result === 'linked' ? { message: 'GitHub is connected to your account.', success: true, connectRequired: false } : { message: githubMessage(result), success: false, connectRequired: result === 'github_account_link_required' };
}

function authorizationUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error();
  const url = new URL(value), parameters = [...url.searchParams], keys = parameters.map(([key]) => key);
  if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize' || url.username || url.password || url.hash || keys.length !== 6 || new Set(keys).size !== 6 || keys.some(key => !['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method'].includes(key))) throw new Error();
  const callback = new URL('/api/control/auth/github/callback', window.location.origin);
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(callback.hostname);
  if (callback.protocol !== 'https:' && !loopback || url.searchParams.get('redirect_uri') !== callback.href || url.searchParams.get('scope') !== 'user:email' || url.searchParams.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{1,200}$/.test(url.searchParams.get('client_id') || '') || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') || '') || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') || '')) throw new Error();
  return url.href;
}

export function mountGithubSignIn(options: {
  container: HTMLElement; mode: 'login' | 'link';
  request: (path: string, body: Json) => Promise<Json>;
  setBusy: (busy: boolean) => boolean;
}): () => void {
  const { container, mode, request } = options;
  const button = container.querySelector<HTMLButtonElement>(mode === 'link' ? '[data-github-connect]' : '[data-github-start]');
  const status = container.querySelector<HTMLElement>(mode === 'link' ? '[data-github-link-status]' : '[data-github-status]');
  const error = container.querySelector<HTMLElement>(mode === 'link' ? '[data-github-link-error]' : '[data-github-error]');
  if (!button || !status || !error) return () => {};
  let active = true, pending = false;
  container.hidden = false;
  const start = async () => {
    if (!active || pending || !options.setBusy(true)) return;
    pending = true; button.disabled = true; button.setAttribute('aria-busy', 'true');
    error.hidden = true; error.textContent = ''; status.textContent = 'Opening GitHub…';
    try {
      const result = await request('/auth/github/start', { mode });
      if (!active) return;
      if (result.expires_in !== 300) throw new Error();
      window.location.assign(authorizationUrl(result.authorization_url));
    } catch (cause) {
      if (!active) return;
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : '';
      error.textContent = githubMessage(code); error.hidden = false; status.textContent = '';
      options.setBusy(false); button.disabled = false; button.removeAttribute('aria-busy'); button.focus(); pending = false;
    }
  };
  button.addEventListener('click', start);
  return () => { active = false; button.removeEventListener('click', start); container.hidden = true; if (pending) options.setBusy(false); };
}
