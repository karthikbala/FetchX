const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STORAGE_KEY = 'fetchx-connect-return';
const TTL_MS = 600_000;
type Purpose = 'review' | 'create';

export function connectRequestId(fragment: string): string | null {
  const id = fragment.startsWith('#') ? fragment.slice(1) : '';
  return UUID.test(id) ? id : null;
}

export function rememberConnectReturn(requestId: string, purpose: Purpose): boolean {
  if (!UUID.test(requestId)) return false;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ requestId, purpose, expiresAt: Date.now() + TTL_MS }));
    return true;
  } catch { return false; }
}

export function readConnectReturn(): { href: string; purpose: Purpose } | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { requestId, purpose, expiresAt } = JSON.parse(raw);
    if (typeof requestId === 'string' && UUID.test(requestId) && (purpose === 'review' || purpose === 'create') &&
        typeof expiresAt === 'number' && expiresAt > Date.now() && expiresAt <= Date.now() + TTL_MS) {
      return { href: '/connect#' + requestId, purpose };
    }
  } catch { /* Unavailable or invalid tab storage cannot redirect. */ }
  clearConnectReturn();
  return null;
}

export function clearConnectReturn(): void {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* The link still works with no storage. */ }
}
