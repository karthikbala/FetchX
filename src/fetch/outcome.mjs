// What a site's response means for FetchX: data, a real "not found", a block,
// a rate limit, a login wall, a site error. Classification is generic (no
// per-site rules): status codes, well-known challenge markers and vendor
// fingerprints. A challenge page is a block whatever its HTTP status.

const SCAN_BYTES = 65536;
// Comments and raw-text elements are removed before matching, so documentation
// that mentions a captcha is not mistaken for one. Script bodies are kept for
// the DataDome loader check below.
const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;
const QUOTED_TEXT = /<(pre|code|textarea|xmp|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const SECURITY_TITLE = /^(?:just a moment\.{0,3}|security check(?:\s*[|–-].*)?|robot check|verify (?:that )?you are (?:a )?human|bot or not\??|attention required!?(?:\s*\|.*)?|pardon our interruption|are you a (?:human|robot)\??|access denied|one more step)$/i;
const CHALLENGE_TEXT = /verify (?:that )?you are (?:a )?human|verify (?:that )?you(?:'|’)?re not a robot|verify (?:that )?you are not a robot|human or a bot|action=["'][^"']*validateCaptcha|\/\/(?:geo\.)?captcha-delivery\.com\/|\/cdn-cgi\/challenge-platform\/h\/[bg]\/orchestrate\//i;

const header = (headers, name) => {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value.join(', ') : String(value);
  }
  return '';
};
const isHtml = headers => /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(header(headers, 'content-type'));
const bodyText = body => (Buffer.isBuffer(body) ? body.subarray(0, SCAN_BYTES).toString('utf8')
  : typeof body === 'string' ? body.slice(0, SCAN_BYTES) : '');

function scriptSources(html) {
  const sources = [];
  for (const match of html.matchAll(/<(script|iframe)\b([^>]{0,4096})>/gi)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[2]);
    if (!src) continue;
    try {
      const url = new URL(src[1] ?? src[2] ?? src[3], 'https://relative.invalid');
      sources.push({tag: match[1].toLowerCase(), host: url.hostname, path: url.pathname, href: url.href});
    } catch { /* not a URL */ }
  }
  return sources;
}

const hostIs = (host, domain) => host === domain || host.endsWith('.' + domain);

// Captcha widgets present on a page, with what a solver needs.
export function captchaWidgets(html) {
  const widgets = [];
  const sitekey = selector => new RegExp(`class=["'][^"']*${selector}[^"']*["'][^>]*data-sitekey=["']([A-Za-z0-9_-]{10,200})["']|data-sitekey=["']([A-Za-z0-9_-]{10,200})["'][^>]*class=["'][^"']*${selector}`, 'i');
  const turnstile = sitekey('cf-turnstile').exec(html);
  if (turnstile) widgets.push({type: 'turnstile', site_key: turnstile[1] ?? turnstile[2]});
  const recaptcha = sitekey('g-recaptcha').exec(html);
  if (recaptcha) widgets.push({type: 'recaptcha_v2', site_key: recaptcha[1] ?? recaptcha[2]});
  const hcaptcha = sitekey('h-captcha').exec(html);
  if (hcaptcha) widgets.push({type: 'hcaptcha', site_key: hcaptcha[1] ?? hcaptcha[2]});
  for (const source of scriptSources(html)) {
    if (source.tag === 'iframe' && hostIs(source.host, 'captcha-delivery.com')) widgets.push({type: 'datadome', captcha_url: source.href});
  }
  return widgets;
}

// Identifies a challenge or block page and its vendor. Returns null when the
// response is not one.
export function detectChallenge({status = null, headers = {}, body = null} = {}) {
  if (header(headers, 'cf-mitigated').trim().toLowerCase() === 'challenge') return {vendor: 'cloudflare'};
  const aws = header(headers, 'x-amzn-waf-action').trim().toLowerCase();
  if (aws === 'challenge' || aws === 'captcha') return {vendor: 'aws_waf'};
  if (!isHtml(headers)) return null;
  const raw = bodyText(body).replace(COMMENTS, '');
  const html = raw.replace(QUOTED_TEXT, '');
  const title = /<title\b[^>]*>([^<]{0,300})<\/title\s*>/i.exec(html)?.[1]?.trim() ?? '';
  const securityTitle = SECURITY_TITLE.test(title);
  const blockStatus = status === 403 || status === 429 || status === 405;
  const sources = scriptSources(html);
  if (sources.some(s => s.tag === 'iframe' && hostIs(s.host, 'captcha-delivery.com'))
    || ((blockStatus || securityTitle) && /\bvar\s+dd\s*=\s*\{[^}]{0,2000}['"]cid['"]\s*:/.test(raw))) {
    return {vendor: 'datadome'};
  }
  if (securityTitle && (/\b(?:window\.)?_cf_chl_opt\s*=/.test(raw) || sources.some(s => s.path.startsWith('/cdn-cgi/challenge-platform/')))) {
    return {vendor: 'cloudflare'};
  }
  if (sources.some(s => hostIs(s.host, 'px-cdn.net') && s.host.startsWith('captcha.')) && (blockStatus || securityTitle)) {
    return {vendor: 'human'};
  }
  if ((blockStatus || securityTitle) && /\b(?:_Incapsula_Resource|incap_ses_)/.test(raw)) return {vendor: 'imperva'};
  if ((blockStatus || securityTitle) && /errors\.edgesuite\.net|Reference&#32;&#35;/.test(raw)) return {vendor: 'akamai'};
  if (securityTitle || CHALLENGE_TEXT.test(html)) return {vendor: 'unknown'};
  return null;
}

// An HTML page with almost no text and a single application root: the real
// content is drawn by JavaScript, so auto mode should move to a browser.
export function isJavaScriptShell({headers = {}, body = null} = {}) {
  if (!isHtml(headers)) return false;
  const html = bodyText(body);
  if (!/<script\b/i.test(html)) return false;
  const text = html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const appRoot = /<(div|main|section|app-root)\b[^>]*\bid=["'](?:root|app|__next|__nuxt|main|application)["'][^>]*>\s*<\/\1>/i.test(html)
    || /<app-root\b/i.test(html);
  return text.length < 200 && (appRoot || /enable javascript|requires javascript|javascript is (?:disabled|required)/i.test(html));
}

// Classifies a site response. `answered` is a real 404/410: the site's answer,
// charged like a success. `needs_browser` is a 200 whose content is drawn by
// JavaScript; it is a success over HTTP if no browser step is allowed.
export function classifyResponse({status, headers, body}, {transport = 'http'} = {}) {
  const challenge = detectChallenge({status, headers, body});
  if (challenge) return {outcome: 'blocked', challenge};
  if (status === 429) return {outcome: 'rate_limited'};
  if (status === 401 || status === 407) return {outcome: 'login_required'};
  if (status === 403) return {outcome: 'blocked', challenge: null};
  if (status === 404 || status === 410) return {outcome: 'answered'};
  if (status >= 500) return {outcome: 'site_error'};
  if (status >= 400) return {outcome: 'site_error'};
  if (transport === 'http' && status >= 200 && status < 300 && isJavaScriptShell({headers, body})) return {outcome: 'needs_browser'};
  return {outcome: 'success'};
}

export function retryAfterSeconds(headers) {
  const raw = header(headers, 'retry-after').trim();
  if (!raw) return null;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, seconds) : null;
}

export {header as responseHeader};
