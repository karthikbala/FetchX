// Google credentials exist only long enough to complete the same-origin sign-in.
// The server validates them and owns the HttpOnly session and challenge cookies.
type Json = Record<string, unknown>;
interface CredentialResponse { credential?: string }
interface GoogleIdentity {
  initialize(options: {
    client_id: string; nonce: string; callback: (response: CredentialResponse) => void;
    ux_mode: 'popup'; auto_select: false; button_auto_select: false;
  }): void;
  renderButton(parent: HTMLElement, options: {
    type: 'standard'; theme: 'outline'; size: 'large'; text: 'continue_with';
    shape: 'rectangular'; logo_alignment: 'left'; width: number;
    click_listener: () => void;
  }): void;
}
declare global { interface Window { google?: { accounts?: { id?: GoogleIdentity } } } }

const SCRIPT = 'https://accounts.google.com/gsi/client';
const CLIENT = /^[A-Za-z0-9_-]{8,200}\.apps\.googleusercontent\.com$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unavailable = 'Google sign-in is unavailable right now. Continue with an email code, or reload Google sign-in.';
function identity(): GoogleIdentity | undefined {
  const id = window.google?.accounts?.id;
  return typeof id?.initialize === 'function' && typeof id.renderButton === 'function' ? id : undefined;
}
async function loadGoogle(): Promise<GoogleIdentity> {
  const loaded = identity(); if (loaded) return loaded;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
    const script = existing ?? document.createElement('script');
    const finish = (ok: boolean) => {
      clearTimeout(timer); script.removeEventListener('load', onLoad); script.removeEventListener('error', onError);
      if (ok) resolve(); else reject(new Error(unavailable));
    };
    const onLoad = () => finish(true), onError = () => finish(false);
    const timer = setTimeout(onError, 10_000);
    script.addEventListener('load', onLoad, { once: true }); script.addEventListener('error', onError, { once: true });
    if (!existing) { script.src = SCRIPT; script.async = true; script.referrerPolicy = 'strict-origin-when-cross-origin'; document.head.append(script); }
  });
  const id = identity(); if (!id) throw new Error(unavailable); return id;
}
function failureMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  if (code === 'google_email_verification_required') return 'Use an email code to verify this address. Google does not manage its email inbox.';
  if (code === 'google_identity_conflict') return 'This Google account could not be connected. Continue with an email code for your FetchX account.';
  if (code === 'google_verification_invalid' || code === 'google_challenge_invalid') return 'Google sign-in expired or could not be verified. Reload Google sign-in, or continue with an email code.';
  return unavailable;
}

export function mountGoogleSignIn(options: {
  container: HTMLElement; clientId: string;
  request: (path: string, body: Json) => Promise<Json>;
  onSession: (session: Json) => void;
}): () => void {
  const { container, clientId, request, onSession } = options;
  const button = container.querySelector<HTMLElement>('[data-google-button]');
  const status = container.querySelector<HTMLElement>('[data-google-status]');
  const error = container.querySelector<HTMLElement>('[data-google-error]');
  const reload = container.querySelector<HTMLButtonElement>('[data-google-reload]');
  if (!button || !status || !error || !reload || !CLIENT.test(clientId)) return () => {};
  let active = true, verifying = false, expired = false, renderedWidth = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined, observer: ResizeObserver | undefined;
  let challengeId = '';
  container.hidden = false;
  error.hidden = true; error.textContent = ''; reload.hidden = true;
  status.textContent = 'Loading Google sign-in…';
  function fail(message: string) {
    if (!active) return;
    expired = true; challengeId = ''; clearTimeout(expiry);
    error!.textContent = message; error!.hidden = false;
    status!.textContent = ''; button!.replaceChildren(); reload!.hidden = false;
    container.removeAttribute('aria-busy'); observer?.disconnect();
  }
  const reloadPage = () => window.location.reload();
  reload.addEventListener('click', reloadPage);
  const dispose = () => {
    active = false; challengeId = ''; clearTimeout(expiry); observer?.disconnect();
    reload.removeEventListener('click', reloadPage); window.removeEventListener('pagehide', dispose);
    button.replaceChildren(); container.hidden = true;
  };
  window.addEventListener('pagehide', dispose, { once: true });
  async function verify(response: CredentialResponse) {
    if (!active || verifying || expired) return;
    if (typeof response.credential !== 'string' || !response.credential || response.credential.length > 16_384) { fail('Google did not return a usable sign-in. Reload Google sign-in, or continue with an email code.'); return; }
    verifying = true; container.setAttribute('aria-busy', 'true');
    status!.textContent = 'Verifying your Google account…';
    let credential = response.credential;
    try {
      const session = await request('/auth/google/verify', { challenge_id: challengeId, credential });
      if (!active) return;
      dispose(); onSession(session);
    } catch (cause) { fail(failureMessage(cause)); }
    finally { credential = ''; verifying = false; container.removeAttribute('aria-busy'); }
  }
  void (async () => {
    try {
      const google = await loadGoogle(); if (!active) return;
      const challenge = await request('/auth/google/challenge', {}); if (!active) return;
      if (typeof challenge.challenge_id !== 'string' || !UUID.test(challenge.challenge_id) || typeof challenge.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(challenge.nonce) || challenge.client_id !== clientId || typeof challenge.expires_in !== 'number' || !Number.isInteger(challenge.expires_in) || challenge.expires_in < 1 || challenge.expires_in > 300) throw new Error(unavailable);
      challengeId = challenge.challenge_id;
      google.initialize({ client_id: clientId, nonce: challenge.nonce, callback: response => { void verify(response); }, ux_mode: 'popup', auto_select: false, button_auto_select: false });
      function render() {
        if (!active || expired || verifying) return;
        const width = Math.max(200, Math.min(400, Math.floor(button!.clientWidth)));
        if (width === renderedWidth) return;
        renderedWidth = width; button!.replaceChildren();
        google.renderButton(button!, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', logo_alignment: 'left', width, click_listener: () => { if (active && !verifying) status!.textContent = 'Choose your Google account in the sign-in window, or continue with an email code.'; } });
      }
      status!.textContent = ''; render();
      observer = new ResizeObserver(render); observer.observe(button!);
      expiry = setTimeout(() => { expired = true; fail('Google sign-in expired. Reload Google sign-in, or continue with an email code.'); }, challenge.expires_in * 1000);
    } catch (cause) { fail(failureMessage(cause)); }
  })();
  return dispose;
}
