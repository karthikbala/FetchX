import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const hostedOrigin = 'https://fetchx.ai';
const hostedApiOrigin = 'https://app.fetchx.ai';
const requestTimeoutMs = 10_000;
const slowDownMs = 5_000;
const claimFailureLimit = 3;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const projectIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const userCodePattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const deviceCodePattern = /^[A-Za-z0-9_-]{43}$/;
const clientNamePattern = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,59}$/;
const limitFields = ['credits_per_day', 'credits_per_month', 'expires_at', 'expires_in_days'];
// A request lasts 20 minutes today; accept up to an hour.
const maxExpiresIn = 3600;

class ConnectError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function invalidResponse() {
  return new ConnectError('connect_invalid_response', 'FetchX Connect returned an invalid response.');
}

function expired() {
  return new ConnectError('connect_expired', 'The FetchX Connect request expired.');
}

function networkError() {
  return new ConnectError('connect_network_error', 'The FetchX Connect service could not be reached.');
}

function validateOrigin(value) {
  const invalid = () => new ConnectError('connect_invalid_origin', 'Use a verified HTTPS origin or a loopback HTTP origin.');
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value) || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  const url = URL.parse(value);
  if (!url || (url.protocol === 'http:' && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value))) throw invalid();
  return url.origin;
}

function remaining(deadline) {
  const milliseconds = Math.ceil(deadline - performance.now());
  if (milliseconds <= 0) throw expired();
  return milliseconds;
}

async function post(origin, route, body, timeoutMs) {
  let response;
  try {
    response = await fetch(`${origin}/api/control/connect/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw networkError();
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status >= 300 && response.status < 400) {
      throw new ConnectError('connect_redirect', 'FetchX Connect redirected the request. Verify the configured site origin.');
    }
    return { status: response.status, retryAfter: response.headers.get('retry-after') };
  }
  try {
    return { status: response.status, data: await response.json() };
  } catch (error) {
    throw error instanceof SyntaxError ? invalidResponse() : networkError();
  }
}

async function announce(onApproval, details, deadline) {
  const timer = new AbortController();
  try {
    await Promise.race([
      sleep(remaining(deadline), undefined, { signal: timer.signal }).then(() => { throw expired(); }),
      Promise.resolve().then(() => onApproval(Object.freeze(details))).catch(() => {
        throw new ConnectError('connect_callback_failed', 'The FetchX Connect approval link could not be delivered.');
      }),
    ]);
  } finally {
    timer.abort();
  }
}

function limitsInput(limits) {
  if (limits === undefined || limits === null) return undefined;
  const plain = typeof limits === 'object' && !Array.isArray(limits);
  if (!plain || Object.keys(limits).some(key => !limitFields.includes(key))) {
    throw new ConnectError('connect_invalid_limits', `Key limits take only ${limitFields.join(', ')}.`);
  }
  return { ...limits };
}

function limitsView(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return { credits_per_day: value.credits_per_day ?? null, credits_per_month: value.credits_per_month ?? null, expires_at: value.expires_at ?? null };
}

/**
 * Give onApproval only the browser link and short code. Keep the returned token private.
 * `limits` asks for a capped key: {credits_per_day, credits_per_month, expires_at or
 * expires_in_days}. The user sees them on the approval page and may change them; the
 * result's `limits` are the ones the key has.
 */
export async function connectFetchX({
  origin = hostedOrigin,
  apiOrigin,
  clientName = 'FetchX Connect',
  limits,
  onApproval,
} = {}) {
  const site = validateOrigin(origin);
  const expectedApiOrigin = site === hostedOrigin ? hostedApiOrigin : validateOrigin(apiOrigin ?? site);
  if (site === hostedOrigin && apiOrigin !== undefined && validateOrigin(apiOrigin) !== hostedApiOrigin) {
    throw new ConnectError('connect_invalid_origin', 'Hosted FetchX Connect requires the hosted gateway origin.');
  }
  if (typeof clientName !== 'string' || !clientNamePattern.test(clientName.trim())) {
    throw new ConnectError('connect_invalid_client_name', 'Use a short client name containing letters, numbers, spaces, or . _ ( ) -.');
  }
  if (typeof onApproval !== 'function') {
    throw new ConnectError('connect_callback_required', 'Supply an approval callback for FetchX Connect.');
  }
  const requested = limitsInput(limits);

  const startedAt = performance.now();
  const start = await post(site, 'start', { client_name: clientName.trim(), ...(requested ? { limits: requested } : {}) }, requestTimeoutMs);
  if (start.status === 404 || start.status === 503) {
    throw new ConnectError('connect_unavailable', 'FetchX Connect is unavailable on this deployment.');
  }
  if (start.status === 400 && requested) {
    throw new ConnectError('connect_invalid_limits', 'FetchX Connect refused the requested key limits.');
  }
  if (start.status === 429) {
    throw new ConnectError('connect_rate_limited', 'FetchX Connect is rate limited. Try again later.');
  }
  if (start.status >= 500) throw networkError();
  if (!start.data) throw invalidResponse();
  const { request_id, device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = start.data;
  if (typeof request_id !== 'string' || !uuid.test(request_id)) throw invalidResponse();
  const verificationUri = `${site}/connect#${request_id}`;
  if (verification_uri !== verificationUri ||
      typeof device_code !== 'string' || !deviceCodePattern.test(device_code) ||
      typeof user_code !== 'string' || !userCodePattern.test(user_code) ||
      verification_uri_complete !== undefined && verification_uri_complete !== `${verificationUri}&code=${user_code}` ||
      !Number.isInteger(expires_in) || expires_in < 1 || expires_in > maxExpiresIn ||
      !Number.isInteger(interval) || interval < 1 || interval > 60) throw invalidResponse();

  const deadline = startedAt + expires_in * 1000;
  const proof = { request_id, device_code };
  let pollMs = interval * 1000;
  let pollAt = performance.now() + pollMs;
  let failures = 0;
  // verificationUriComplete carries the code, so the user only checks it matches.
  await announce(onApproval, {
    verificationUri, userCode: user_code,
    ...(verification_uri_complete ? { verificationUriComplete: verification_uri_complete } : {}),
  }, deadline);

  for (;;) {
    const waitMs = Math.min(Math.ceil(pollAt - performance.now()), remaining(deadline));
    if (waitMs > 0) await sleep(waitMs);

    let claim;
    try {
      claim = await post(site, 'claim', proof, Math.min(remaining(deadline), requestTimeoutMs));
      if (claim.status >= 500) throw networkError();
    } catch (error) {
      remaining(deadline);
      if (error.code !== 'connect_network_error' || ++failures >= claimFailureLimit) throw error;
      pollAt = performance.now() + pollMs;
      continue;
    }

    remaining(deadline);
    failures = 0;
    if (claim.status === 429) {
      pollMs += slowDownMs;
      const retryMs = /^\d+$/.test(claim.retryAfter ?? '') ? Number(claim.retryAfter) * 1000 : 0;
      pollAt = performance.now() + Math.max(pollMs, retryMs);
      continue;
    }
    if (claim.data?.state === 'pending') {
      pollAt = performance.now() + pollMs;
      continue;
    }
    if (claim.data?.state === 'denied') {
      throw new ConnectError('connect_denied', 'The FetchX Connect request was denied.');
    }
    if (claim.data?.state === 'expired') throw expired();
    if (claim.data?.state !== 'connected') throw invalidResponse();
    const { project_id, key_id, api_base_url } = claim.data;
    if (typeof project_id !== 'string' || !projectIdPattern.test(project_id) ||
        typeof key_id !== 'string' || !uuid.test(key_id)) throw invalidResponse();
    const apiBaseUrl = validateOrigin(api_base_url);
    if (apiBaseUrl !== expectedApiOrigin) {
      throw new ConnectError('connect_api_origin_mismatch', 'The FetchX gateway origin did not match the configured gateway.');
    }
    const keyLimits = limitsView(claim.data.limits);
    const token = 'fxk_' + createHash('sha256').update(`fetchx-connect-key-v1\0${device_code}`, 'utf8').digest('base64url');
    return { token, apiBaseUrl, projectId: project_id, keyId: key_id, limits: keyLimits };
  }
}

const usage = 'Usage: node connect.mjs [--origin SITE_ORIGIN] [--api-origin GATEWAY_ORIGIN] [--client-name NAME]'
  + ' [--credits-per-day N] [--credits-per-month N] [--expires-in-days N] -- <command> [args...]';

function runChild([command, ...args], { token, apiBaseUrl }) {
  return new Promise((resolve, reject) => {
    const launchError = () => reject(new ConnectError('connect_child_error', 'The requested command could not be started.'));
    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: 'inherit',
        env: { ...process.env, FETCHX_TOKEN: token, FETCHX_URL: apiBaseUrl },
      });
    } catch {
      launchError();
      return;
    }
    child.once('error', launchError);
    child.once('exit', (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 1)));
  });
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  const split = args.indexOf('--');
  if (split < 0 || !args[split + 1] || split % 2 !== 0) throw new ConnectError('connect_usage', usage);
  const names = new Map([['--origin', 'origin'], ['--api-origin', 'apiOrigin'], ['--client-name', 'clientName']]);
  const limitNames = new Map([['--credits-per-day', 'credits_per_day'], ['--credits-per-month', 'credits_per_month'], ['--expires-in-days', 'expires_in_days']]);
  const options = {};
  const limits = {};
  for (let index = 0; index < split; index += 2) {
    const option = names.get(args[index]), limit = limitNames.get(args[index]);
    if (limit && !Object.hasOwn(limits, limit) && /^[1-9]\d{0,8}$/.test(args[index + 1])) {
      limits[limit] = Number(args[index + 1]);
      continue;
    }
    if (!option || Object.hasOwn(options, option)) throw new ConnectError('connect_usage', usage);
    options[option] = args[index + 1];
  }

  const credential = await connectFetchX({
    clientName: 'FetchX Connect CLI',
    ...options,
    ...(Object.keys(limits).length ? { limits } : {}),
    onApproval: ({ verificationUri, verificationUriComplete, userCode }) => {
      process.stderr.write(`Open ${verificationUriComplete ?? verificationUri}\nFetchX code: ${userCode}\n`);
    },
  });
  return runChild(args.slice(split + 1), credential);
}

if (import.meta.main ?? (process.argv[1] === fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof ConnectError ? error.message : 'FetchX Connect failed.'}\n`);
    process.exitCode = 1;
  }
}
