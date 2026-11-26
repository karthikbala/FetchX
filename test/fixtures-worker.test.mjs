// fixtures.fetchx.ai (fixtures-worker/worker.mjs): the pages callers'
// acceptance tests rely on behave as documented. Runs the Worker's handler
// directly, with the CAPTCHA vendors' verification answered locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {PASSWORD, USERNAME, VENDORS} from '../fixtures-worker/worker.mjs';
import {serveFixtures} from '../fixtures-worker/serve.mjs';

const ORIGIN = 'https://fixtures.fetchx.ai';
const call = (path, init = {}, env = {}) => worker.fetch(new Request(new URL(path, init.origin ?? ORIGIN), init), env);
const cookiesOf = answer => answer.headers.getSetCookie().map(cookie => cookie.split(';')[0]);
const form = fields => ({method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(fields)});

test('sign-in: a CSRF-checked form, 302 to /home with fxs and seen, a wrong password answers 200 with #error', async () => {
  const shown = await call('/login');
  assert.equal(shown.status, 200);
  const page = await shown.text();
  for (const id of ['username', 'password', 'signIn']) assert.match(page, new RegExp(`id="${id}"`));
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const [csrfCookie] = cookiesOf(shown);
  assert.equal(csrfCookie, `fxcsrf=${csrf}`);
  assert.match(shown.headers.getSetCookie()[0], /HttpOnly; Path=\/login; Secure/);

  const wrong = await call('/login', {...form({_csrf: csrf, username: USERNAME, password: 'nope'}), headers: {
    'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie}});
  assert.equal(wrong.status, 200);
  assert.match(await wrong.text(), /id="error"[^>]*>Wrong username or password/);

  const stale = await call('/login', {...form({_csrf: 'forged', username: USERNAME, password: PASSWORD}), headers: {
    'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie}});
  assert.equal(stale.status, 403);

  const right = await call('/login', {...form({_csrf: csrf, username: USERNAME, password: PASSWORD}), headers: {
    'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie}});
  assert.equal(right.status, 302);
  assert.equal(right.headers.get('location'), '/home');
  const set = right.headers.getSetCookie();
  assert.match(set[0], /^fxs=[\w-]+\.[\w-]+; HttpOnly; Path=\//);
  assert.match(set[1], /^seen=1; Path=\//);

  const fxs = cookiesOf(right)[0];
  const home = await call('/home', {headers: {cookie: fxs}});
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="logout"/);
  const forged = await call('/home', {headers: {cookie: 'fxs=abc.def'}});
  assert.deepEqual([forged.status, forged.headers.get('location')], [302, '/login']);
  assert.equal((await call('/home')).status, 302);
});

test('echo, ip, the redirect chain and the shadow lookup', async () => {
  const echoed = await (await call('/echo', {method: 'POST', headers: {'content-type': 'text/plain', 'x-trace': 'one'}, body: 'pass=hunter2'})).json();
  assert.equal(echoed.body, 'pass=hunter2');
  assert.equal(echoed.body_encoding, 'utf8');
  assert.ok(echoed.headers.some(([name, value]) => name === 'x-trace' && value === 'one'));
  const binary = await (await call('/echo', {method: 'POST', body: new Uint8Array([0xff, 0xfe, 0x00])})).json();
  assert.deepEqual([binary.body, binary.body_encoding, binary.body_bytes], ['//4A', 'base64', 3]);
  assert.equal((await call('/echo', {method: 'POST', body: new Uint8Array(1_048_577)})).status, 413);
  assert.equal((await call('/echo')).status, 405);

  const ip = await (await call('/ip', {headers: {'cf-connecting-ip': '203.0.113.9', 'user-agent': 'UA/1', 'accept-language': 'en-US'}})).json();
  assert.deepEqual(ip, {ip: '203.0.113.9', user_agent: 'UA/1', accept_language: 'en-US'});

  const hops = [];
  for (let path = '/chain'; path;) {
    const answer = await call(path);
    hops.push([answer.status, cookiesOf(answer)[0]]);
    path = answer.headers.get('location');
  }
  assert.deepEqual(hops, [[302, 'h1=a'], [302, 'h2=b'], [200, 'h3=c']]);

  assert.deepEqual(await (await call('/api/lookup?ids=V1,X2,V3')).json(), {validIds: ['V1', 'V3'], invalidIds: ['X2']});
  const shadow = await (await call('/shadow?delay_ms=99999')).text();
  assert.match(shadow, /attachShadow\(\{mode: 'open'\}\)/);
  assert.match(shadow, /}, 40000\)\);/, 'the delay is capped at 40 s');
});

test('CAPTCHA pages gate #signIn on the widget and verify the token with the vendor', async t => {
  const page = await (await call('/captcha/turnstile')).text();
  assert.match(page, /class="cf-turnstile" data-sitekey="1x00000000000000000000AA" data-callback="fxSolved"/);
  assert.match(page, /id="signIn" type="submit" data-gated disabled/);
  assert.match(await (await call('/captcha/recaptcha-v2')).text(), new RegExp(`data-sitekey="${VENDORS['recaptcha-v2'].sitekey}"`));
  assert.match(await (await call('/captcha/hcaptcha')).text(), /class="h-captcha"/);
  assert.equal((await call('/captcha/mtcaptcha')).status, 503, 'MTCaptcha publishes no test key');
  assert.match(await (await call('/captcha/mtcaptcha', {}, {MTCAPTCHA_SITEKEY: 'MTPublic-x', MTCAPTCHA_PRIVATEKEY: 'MTPrivat-x'})).text(),
    /'verified-callback': 'fxSolved'/);
  assert.equal((await call('/captcha/nope')).status, 404);

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push([String(url), String(init?.body ?? '')]);
    return new Response(JSON.stringify({success: new URLSearchParams(String(init?.body ?? '')).get('response') === 'XXXX.DUMMY.TOKEN.XXXX'}));
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const unsolved = await call('/captcha/turnstile', form({username: USERNAME, password: PASSWORD}));
  assert.match(await unsolved.text(), /The CAPTCHA was not solved/);
  assert.equal(sent.length, 0, 'no token, no call');
  const solved = await call('/captcha/turnstile', form({username: USERNAME, password: PASSWORD, 'cf-turnstile-response': 'XXXX.DUMMY.TOKEN.XXXX'}));
  assert.deepEqual([solved.status, solved.headers.get('location')], [302, '/home']);
  assert.equal(sent[0][0], 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.match(sent[0][1], /secret=1x0000000000000000000000000000000AA/);
});

test('every page asks Cloudflare not to transform it, so no analytics beacon is added', async () => {
  for (const path of ['/', '/login', '/home', '/chain', '/shadow', '/frame', '/exfil', '/api/lookup?ids=V1', '/nope']) {
    const answer = await call(path);
    assert.match(answer.headers.get('cache-control') ?? '', /\bno-transform\b/, path);
    assert.match(answer.headers.get('cache-control') ?? '', /\bno-store\b/, path);
    assert.doesNotMatch(await answer.text(), /cloudflareinsights/, path);
  }
});

test('the framed form lives on frame.<host>, and /exfil tries to reach outside.example', async () => {
  const frame = await (await call('/frame?captcha=none')).text();
  assert.match(frame, /<iframe id="frame" title="form" src="https:\/\/frame\.fixtures\.fetchx\.ai\/form\?captcha=none"/);
  const inner = await call('/form?captcha=none', {origin: 'https://frame.fixtures.fetchx.ai'});
  assert.match(await inner.text(), /id="contact"/);
  const sent = await call('/form?captcha=none', {...form({name: 'Ada'}), origin: 'https://frame.fixtures.fetchx.ai'});
  assert.match(await sent.text(), /id="done">Thanks, Ada\./);
  assert.equal((await call('/login', {origin: 'https://frame.fixtures.fetchx.ai'})).status, 404, 'the frame host serves only the form');
  assert.equal((await call('/form')).status, 404);

  const exfil = await call('/exfil');
  assert.match(await exfil.text(), /https:\/\/outside\.example\/collect/);
  assert.match(exfil.headers.getSetCookie()[0], /^secret=fixture-cookie/);
  const index = await (await call('/')).text();
  assert.match(index, /fixture-user/);
  assert.equal((await call('/robots.txt')).status, 200);
  assert.equal((await call('/shadow', {method: 'HEAD'})).body, null);
});

test('the local copy serves the same pages over HTTP, with the frame on another origin', async t => {
  const fixtures = await serveFixtures();
  t.after(() => fixtures.close());
  const login = await fetch(`${fixtures.url}/login`);
  assert.equal(login.status, 200);
  assert.doesNotMatch(login.headers.getSetCookie()[0], /Secure/, 'a local copy over plain HTTP drops Secure');
  const frame = await (await fetch(`${fixtures.url}/frame?captcha=none`)).text();
  assert.match(frame, new RegExp(`src="${fixtures.frameOrigin}/form\\?captcha=none"`));
  assert.equal((await fetch(`${fixtures.frameOrigin}/form?captcha=none`)).status, 200);
  const chain = await fetch(`${fixtures.url}/chain`, {redirect: 'manual'});
  assert.deepEqual([chain.status, chain.headers.get('location')], [302, '/chain/2']);
});
