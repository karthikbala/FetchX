const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const STORAGE_KEY = 'fetchx-connect-return';
// A Connect request lasts 20 minutes.
const TTL_MS = 1_200_000;

export type ConnectLink = { requestId: string; code: string | null };

// `#<request id>`, or `#<request id>&code=XXXX-XXXX` (verification_uri_complete).
export function connectLink(fragment: string): ConnectLink | null {
  if (!fragment.startsWith('#')) return null;
  const [id, ...rest] = fragment.slice(1).split('&');
  if (!UUID.test(id) || rest.length > 1) return null;
  if (!rest.length) return { requestId: id, code: null };
  const code = rest[0].startsWith('code=') ? decodeURIComponent(rest[0].slice(5)).toUpperCase() : '';
  return CODE.test(code) ? { requestId: id, code } : { requestId: id, code: null };
}

export function connectHref({ requestId, code }: ConnectLink): string {
  return '/connect#' + requestId + (code ? '&code=' + code : '');
}

// Remembers the request (and the code its link carried) while the user signs
// in, for this tab only. The Connect page clears it as soon as it loads.
export function rememberConnectReturn(link: ConnectLink): boolean {
  if (!UUID.test(link.requestId) || link.code !== null && !CODE.test(link.code)) return false;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ requestId: link.requestId, code: link.code, expiresAt: Date.now() + TTL_MS }));
    return true;
  } catch { return false; }
}

export function readConnectReturn(): { href: string } | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { requestId, code, expiresAt } = JSON.parse(raw);
    if (typeof requestId === 'string' && UUID.test(requestId) && (code === null || code === undefined || typeof code === 'string' && CODE.test(code)) &&
        typeof expiresAt === 'number' && expiresAt > Date.now() && expiresAt <= Date.now() + TTL_MS) {
      return { href: connectHref({ requestId, code: code ?? null }) };
    }
  } catch { /* Unavailable or invalid tab storage cannot redirect. */ }
  clearConnectReturn();
  return null;
}

export function clearConnectReturn(): void {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* The link still works with no storage. */ }
}
