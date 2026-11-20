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

// Titles of interactive challenges (a script or captcha decides), as opposed to a
// plain "Access denied", which is often an IP block another route can pass.
const INTERACTIVE_TITLE = /^(?:just a moment\.{0,3}|security check|robot check|verify (?:that )?you are (?:a )?human|bot or not\??|are you a (?:human|robot)\??|pardon our interruption|one more step)/i;
const BROWSER_VENDORS = new Set(['datadome', 'cloudflare', 'human', 'aws_waf', 'imperva']);

// Identifies a challenge or block page and its vendor, and whether only a browser
// can pass it (browser: true). Returns null when the response is not one.
export function detectChallenge(response = {}) {
  const found = identifyChallenge(response);
  if (!found) return null;
  const body = bodyText(response.body ?? null).replace(COMMENTS, '').replace(QUOTED_TEXT, '');
  const title = /<title\b[^>]*>([^<]{0,300})<\/title\s*>/i.exec(body)?.[1]?.trim() ?? '';
  return {...found, browser: BROWSER_VENDORS.has(found.vendor) || INTERACTIVE_TITLE.test(title) || CHALLENGE_TEXT.test(body)};
}

function identifyChallenge({status = null, headers = {}, body = null} = {}) {
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

const SHELL_SCAN_BYTES = 1_048_576;
const NEEDS_JAVASCRIPT = /enable javascript|requires javascript|javascript is (?:disabled|required|not available)/i;
const APP_ROOT = /<(div|main|section|app-root)\b[^>]*\bid=["'](?:root|app|__next|__nuxt|main|application)["'][^>]*>\s*<\/\1>|<app-root\b/i;

const visibleText = html => html
  .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z#0-9]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Prose carried by the page's own inline scripts: string literals of three or
// more words that are not markup, code or URLs. External scripts and JSON-LD
// (which repeats the page for search engines) are not counted.
function scriptProse(html) {
  let total = 0;
  for (const [, attributes, code] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(attributes) || /\btype\s*=\s*["']?application\/ld\+json/i.test(attributes)) continue;
    for (const [literal] of code.matchAll(/"(?:[^"\\\n]|\\.){12,}"|'(?:[^'\\\n]|\\.){12,}'/g)) {
      const inner = literal.slice(1, -1).replace(/\\u00a0|\\[nt]/g, ' ');
      if (/[<>{};=]|https?:|\/\//.test(inner)) continue;
      if (inner.trim().split(/\s+/).length >= 3 && /\p{L}{2}/u.test(inner)) total += inner.length;
    }
  }
  return total;
}

// An HTML page whose content is drawn by JavaScript, so auto mode moves to a
// browser. Generic signals only:
// - scripts and next to no text (a loader, an app shell, a script redirect);
// - little text, and the page says it needs JavaScript or has an empty app root;
// - modest text while its inline scripts carry several times more prose (the
//   content ships as data and is rendered in the browser).
export function isJavaScriptShell({headers = {}, body = null} = {}) {
  if (!isHtml(headers)) return false;
  const html = Buffer.isBuffer(body) ? body.subarray(0, SHELL_SCAN_BYTES).toString('utf8')
    : typeof body === 'string' ? body.slice(0, SHELL_SCAN_BYTES) : '';
  if (!/<script\b/i.test(html)) return false;
  const text = visibleText(html).length;
  if (text < 150) return true;
  if (text < 500 && (APP_ROOT.test(html) || NEEDS_JAVASCRIPT.test(html))) return true;
  if (text >= 1500) return false;
  const prose = scriptProse(html);
  return prose >= 500 && prose > 3 * text;
}

// A page a browser rendered that shows next to nothing: its scripts never drew
// it (an app that did not start, often a quiet block served to that exit IP).
// Only the body's text counts, so a title alone is not content. Pages with
// custom elements are left alone: their text may live in shadow DOM, which a
// saved page does not show.
const EMPTY_RENDER_TEXT = 20;
export function isEmptyRender({headers = {}, body = null} = {}) {
  if (!isHtml(headers)) return false;
  const html = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : '';
  if (!/<script\b/i.test(html)) return false;
  const start = html.search(/<body\b/i);
  const page = start >= 0 ? html.slice(start) : html;
  if (/<[a-z][a-z0-9]*-[a-z0-9-]*[\s>]/i.test(page.replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' '))) return false;
  return visibleText(page).length < EMPTY_RENDER_TEXT;
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
  // Not a success, and never billed: the next step tries a fresh IP.
  if (transport === 'browser' && status >= 200 && status < 300 && isEmptyRender({headers, body})) return {outcome: 'blocked', challenge: null};
  return {outcome: 'success'};
}

export function retryAfterSeconds(headers) {
  const raw = header(headers, 'retry-after').trim();
  if (!raw) return null;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, seconds) : null;
}

