// The capture input exchanged between the gateway, a worker host and a worker
// process. Checked at every hop; anything else is refused.
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const FIELDS = ['url', 'deadline', 'runtime', 'limits', 'settle_ms', 'wait_for', 'screenshot', 'captcha', 'headers', 'cookies',
  'locale', 'timezone'];

export function checkCaptureInput(value) {
  const ok = plain(value) && Object.keys(value).every(key => FIELDS.includes(key))
    && typeof value.url === 'string' && value.url.length <= 12000 && /^https:\/\//i.test(value.url)
    && integer(value.deadline, Date.now() + 1, Date.now() + 180_000)
    && plain(value.runtime) && value.runtime.engine === 'camoufox'
    && plain(value.limits) && integer(value.limits.max_requests, 1, 500)
    && integer(value.limits.max_dom_bytes, 1024, 10_000_000) && integer(value.limits.max_body_bytes, 1024, 25_000_000)
    && integer(value.settle_ms ?? 0, 0, 5000)
    && (value.wait_for == null || (plain(value.wait_for) && integer(value.wait_for.ms, 0, 10_000)
      && (value.wait_for.selector == null || (typeof value.wait_for.selector === 'string' && value.wait_for.selector.length <= 512))))
    && typeof value.screenshot === 'boolean' && typeof value.captcha === 'boolean'
    && plain(value.headers ?? {}) && Object.values(value.headers ?? {}).every(v => typeof v === 'string')
    && Array.isArray(value.cookies ?? []) && (value.cookies ?? []).length <= 100
    && (value.locale === undefined || (typeof value.locale === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value.locale)))
    && (value.timezone === undefined || (typeof value.timezone === 'string' && /^[A-Za-z_]+\/[A-Za-z_]+$/.test(value.timezone)));
  if (!ok) throw new Error('invalid capture input');
  return {...value, settle_ms: value.settle_ms ?? 0, wait_for: value.wait_for ?? null, headers: value.headers ?? {},
    cookies: value.cookies ?? []};
}
