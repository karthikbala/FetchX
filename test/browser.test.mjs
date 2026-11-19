import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {capturePage} from '../src/browser/capture.mjs';
import {detectCaptcha, solvePageCaptchas} from '../src/browser/page-captcha.mjs';
import {startRelay} from '../src/browser/relay.mjs';
import {BrowserWorkerPool} from '../src/browser/pool.mjs';
import {startBrowserWorker} from '../src/browser/worker-service.mjs';
import {BrowserSlots} from '../src/browser/queue.mjs';
import {checkCaptureInput} from '../src/browser/capture-input.mjs';
import {CAMOUFOX_PIN, camoufoxOptions, browserRuntime, fileSha256} from '../src/browser/engine.mjs';

// Real-browser tests run when BROWSER_TEST_EXECUTABLE points at a Chromium
// build. Capture uses only the Playwright API, so it is engine-neutral; the
// Camoufox launch itself is covered where a pinned build is installed.
const executable = process.env.BROWSER_TEST_EXECUTABLE;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const KEY = '0x4AAAAAAAsyntheticKey01';

async function withBrowser(run) {
  const {chromium} = await import('playwright-core');
  const browser = await chromium.launch({executablePath: executable, headless: true});
  try { await run(browser); } finally { await browser.close(); }
}

function site(pages) {
  return http.createServer((req, res) => {
    const page = pages[new URL(req.url, 'http://x').pathname];
    if (!page) return res.writeHead(404).end('missing');
    const body = typeof page === 'function' ? page(req) : page;
    res.writeHead(200, {'content-type': body.type ?? 'text/html; charset=utf-8', ...(body.headers ?? {})}).end(body.body ?? body);
  });
}

const baseInput = url => ({url, deadline: Date.now() + 30_000, limits: {max_requests: 20, max_dom_bytes: 1_000_000, max_body_bytes: 1_000_000},
  settle_ms: 0, wait_for: null, screenshot: false, captcha: false, headers: {}, cookies: []});

test('capture admits every request, refuses what the gateway refuses, and returns DOM, screenshot and cookies', {skip: !executable}, async t => {
  const server = site({
    '/page': {body: '<html><body><h1 id="title">Hi</h1><img src="/blocked.png"><script>setTimeout(()=>{document.body.insertAdjacentHTML("beforeend","<p id=late>late</p>")},300)</script></body></html>',
      headers: {'set-cookie': 'sid=abc; Path=/'}},
    '/data.json': {type: 'application/json', body: '{"a":1}'},
  });
  const port = await listen(server);
  t.after(() => close(server));
  await withBrowser(async browser => {
    const admitted = [];
    const artifacts = {};
    const hooks = {
      admit: async meta => {
        admitted.push(meta);
        if (meta.url.endsWith('/blocked.png')) throw Object.assign(new Error('no'), {code: 'url_not_allowed'});
      },
      artifact: async data => { artifacts[data.kind] = Buffer.from(data.body_base64, 'base64'); },
    };
    const url = `http://127.0.0.1:${port}/page`;
    const result = await capturePage(browser, {...baseInput(url), screenshot: true, wait_for: {selector: '#late', ms: 5000},
      headers: {'x-caller': '1'}}, hooks);
    assert.equal(result.status, 200);
    assert.equal(result.wait_for, 'matched');
    assert.match(artifacts.dom.toString(), /<p id="late">late<\/p>/);
    assert.ok(artifacts.screenshot.length > 1000);
    assert.equal(result.blocked, 1);
    assert.deepEqual(result.blocked_reasons, {url_not_allowed: 1});
    assert.equal(admitted[0].frame, 'main');
    assert.deepEqual(result.cookies.map(c => [c.name, c.value]), [['sid', 'abc']]);
    // A non-HTML document is captured as received.
    const json = await capturePage(browser, baseInput(`http://127.0.0.1:${port}/data.json`), hooks);
    assert.equal(json.status, 200);
    assert.equal(artifacts.document.toString(), '{"a":1}');
  });
});

test('the caller\'s cookies reach the page\'s origin and the cookies the site sets come back, across a redirect', {skip: !executable}, async t => {
  let seen = null;
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/start') return res.writeHead(302, {location: '/account'}).end();
    if (path === '/account') {
      seen = req.headers.cookie ?? null;
      return res.writeHead(200, {'content-type': 'text/html', 'set-cookie': 'step=2; Path=/'}).end('<html><body>account</body></html>');
    }
    res.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => close(server));
  await withBrowser(async browser => {
    const base = `http://127.0.0.1:${port}`;
    const result = await capturePage(browser, {...baseInput(base + '/start'), cookies: [{name: 'session', value: 'caller', url: base}]},
      {admit: async () => {}, artifact: async () => {}});
    assert.equal(result.status, 200);
    assert.equal(result.final_url, base + '/account');
    assert.match(seen, /session=caller/);
    assert.ok(result.cookies.some(cookie => cookie.name === 'step' && cookie.value === '2'));
  });
});

test('page captchas: Turnstile through its form, reCAPTCHA through its callback, DataDome through its cookie', {skip: !executable}, async t => {
  let datadomeCleared = false;
  const server = site({
    '/turnstile': `<form action="/done" method="GET"><div class="cf-turnstile" data-sitekey="${KEY}"></div><input type="hidden" name="cf-turnstile-response"></form>`,
    '/done': req => `<main>ok ${new URL(req.url, 'http://x').searchParams.get('cf-turnstile-response').length}</main>`,
    '/recaptcha': `<div class="g-recaptcha" data-sitekey="${KEY}" data-callback="solved"></div><textarea name="g-recaptcha-response"></textarea>
      <script>window.solved=t=>{document.body.innerHTML='<main>unlocked '+t.length+'</main>'}</script>`,
    '/guarded': req => (req.headers.cookie?.includes('datadome=good') ? (datadomeCleared = true, '<main>through</main>')
      : '<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=1&t=fe"></iframe>'),
  });
  const port = await listen(server);
  t.after(() => close(server));
  await withBrowser(async browser => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const asked = [];
    const hooks = {captcha: async data => {
      asked.push(data.type);
      return data.type === 'datadome' ? {cookie: 'datadome=good; Path=/'} : {token: 't'.repeat(40)};
    }};
    await page.goto(`http://127.0.0.1:${port}/turnstile`);
    assert.deepEqual(await detectCaptcha(page), {type: 'turnstile', site_key: KEY, callback: null});
    assert.deepEqual(await solvePageCaptchas(page, context, hooks, {deadline: Date.now() + 60_000}),
      [{type: 'turnstile', outcome: 'passed', submitted_via: 'form'}]);
    assert.match(await page.content(), /ok 40/);
    await page.goto(`http://127.0.0.1:${port}/recaptcha`);
    assert.deepEqual(await solvePageCaptchas(page, context, hooks, {deadline: Date.now() + 60_000}),
      [{type: 'recaptcha_v2', outcome: 'passed', submitted_via: 'callback'}]);
    await page.goto(`http://127.0.0.1:${port}/guarded`);
    const datadome = await solvePageCaptchas(page, context, hooks, {deadline: Date.now() + 60_000});
    assert.deepEqual(datadome, [{type: 'datadome', outcome: 'passed', submitted_via: 'cookie'}]);
    assert.equal(datadomeCleared, true);
    assert.deepEqual(asked, ['turnstile', 'recaptcha_v2', 'datadome']);
    // Not enough time left: reported, nothing paid for.
    await page.goto(`http://127.0.0.1:${port}/turnstile`);
    assert.deepEqual(await solvePageCaptchas(page, context, hooks, {deadline: Date.now() + 5000}), [{type: 'turnstile', outcome: 'captcha_deadline'}]);
    assert.equal(asked.length, 3);
    await context.close();
  });
});

test('the relay only tunnels to pinned hosts, counts every byte and stops at the cap', async t => {
  const echo = net.createServer(socket => socket.pipe(socket));
  const port = await listen(echo);
  t.after(() => close(echo));
  const pins = new Map([['pinned.example.com', {destination: {url: new URL('https://pinned.example.com'), address: '127.0.0.1', family: 4}, permits: 1}]]);
  let connects = 0;
  const relay = await startRelay({pins, maxBytes: 64, deadline: Date.now() + 10_000, onConnect: async () => { connects++; },
    dial: () => net.connect(port, '127.0.0.1')});
  t.after(() => relay.close());
  const tunnel = target => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: Number(new URL(relay.url).port), method: 'CONNECT', path: target});
    req.once('connect', (res, socket) => resolve({status: res.statusCode, socket}));
    req.once('error', reject);
    req.end();
  });
  const refused = await tunnel('elsewhere.example.com:443');
  assert.equal(refused.status, 403);
  refused.socket.destroy();
  const open = await tunnel('pinned.example.com:443');
  assert.equal(open.status, 200);
  open.socket.write('hello');
  const echoed = await new Promise(resolve => open.socket.once('data', resolve));
  assert.equal(echoed.toString(), 'hello');
  assert.equal(connects, 1);
  assert.equal(relay.bytes, 10, 'both directions');
  const again = await tunnel('pinned.example.com:443');
  assert.equal(again.status, 403, 'one permit, one connection');
  again.socket.destroy();
  open.socket.write('x'.repeat(100));
  await new Promise(resolve => open.socket.once('close', resolve));
  assert.equal(relay.error, 'too_large');
});

test('the relay asks before tunnelling to a host nothing pinned, such as a redirect hop', async t => {
  const echo = net.createServer(socket => socket.pipe(socket));
  const port = await listen(echo);
  t.after(() => close(echo));
  const pins = new Map(), asked = [];
  const admitHost = async host => {
    asked.push(host);
    if (host === 'private.example.com') throw Object.assign(new Error('no'), {code: 'url_not_allowed'});
    const pin = {destination: {url: new URL(`https://${host}`), address: '127.0.0.1', family: 4}, permits: 1};
    pins.set(host, pin);
    return pin;
  };
  const relay = await startRelay({pins, admitHost, maxBytes: 1000, deadline: Date.now() + 10_000, dial: () => net.connect(port, '127.0.0.1')});
  t.after(() => relay.close());
  const tunnel = target => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: Number(new URL(relay.url).port), method: 'CONNECT', path: target});
    req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.once('error', reject);
    req.end();
  });
  assert.equal(await tunnel('www.example.com:443'), 200);
  assert.equal(await tunnel('private.example.com:443'), 403);
  assert.deepEqual(asked, ['www.example.com', 'private.example.com']);
});

test('pool and worker host carry a capture and its callbacks end to end', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fx-pool-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const executablePath = join(directory, 'camoufox-bin');
  await writeFile(executablePath, 'synthetic pinned browser');
  await chmod(executablePath, 0o700);
  const sha256 = await fileSha256(executablePath);
  const pin = {engine: 'camoufox', version: CAMOUFOX_PIN.version, sha256, executablePath, modelDir: directory};
  const callbackSocket = join(directory, 'callback.sock');
  const socketPath = join(directory, 'worker.sock');
  const pool = new BrowserWorkerPool({registry_path: join(directory, 'registry.json'), callback_socket: callbackSocket});
  const seen = [];
  const worker = await startBrowserWorker({socketPath, callbackSocket, pin, runner: async (input, hooks) => {
    seen.push(input);
    await hooks.admit({url: input.url, method: 'GET', resource_type: 'document', frame: 'main'});
    await hooks.artifact({kind: 'dom', content_type: 'text/html', body_base64: Buffer.from('<p>dom</p>').toString('base64')});
    const answer = await hooks.captcha({type: 'turnstile', website_url: input.url, site_key: KEY, user_agent: 'UA'});
    return {status: 200, final_url: input.url, headers: {}, cookies: [], captcha: [{type: 'turnstile', outcome: answer.token ? 'passed' : 'failed'}], requests: 1, blocked: 0};
  }});
  t.after(async () => { await pool.close(); await worker.close(); });
  await writeFile(join(directory, 'registry.json'), JSON.stringify([{id: 'w1', state: 'active', socket_path: socketPath}]));
  await pool.start();
  const runtime = {engine: 'camoufox', version: CAMOUFOX_PIN.version, sha256};
  const slots = new BrowserSlots({pool});
  const slot = await slots.acquire(runtime, {deadline: Date.now() + 5000});
  const relay = await startRelay({pins: new Map(), maxBytes: 1000, deadline: Date.now() + 10_000});
  t.after(() => relay.close());
  const calls = [];
  try {
    const input = {...baseInput('https://shop.example.com/'), runtime, relay: relay.url, captcha: true, locale: 'en-US', timezone: 'America/New_York'};
    const output = await slot.run(input, {
      admit: async meta => { calls.push(['admit', meta.url]); return {ok: true}; },
      artifact: async data => { calls.push(['artifact', data.kind]); return {ok: true}; },
      captcha: async data => { calls.push(['captcha', data.type]); return {ok: true, token: 't'.repeat(30)}; },
    });
    assert.equal(output.status, 200);
    assert.deepEqual(output.captcha, [{type: 'turnstile', outcome: 'passed'}]);
    assert.deepEqual(calls, [['admit', 'https://shop.example.com/'], ['artifact', 'dom'], ['captcha', 'turnstile']]);
    assert.equal(seen[0].runtime.executablePath, executablePath, 'the worker uses its own pinned binary');
  } finally {
    slot.release();
  }
  // A worker on a different build is not used.
  await assert.rejects(slots.acquire({...runtime, sha256: 'b'.repeat(64)}, {deadline: Date.now() + 600}), {code: 'browser_capacity'});
});

test('capture input and Camoufox launch options are strict', () => {
  const runtime = {engine: 'camoufox', version: CAMOUFOX_PIN.version, sha256: 'a'.repeat(64)};
  assert.ok(checkCaptureInput({...baseInput('https://a.example.com/'), runtime}));
  for (const bad of [{url: 'http://a.example.com/'}, {deadline: Date.now() - 1}, {limits: {max_requests: 0, max_dom_bytes: 1024, max_body_bytes: 1024}},
    {runtime: {engine: 'chromium'}}, {wait_for: {ms: 99_999}}, {extra: true}, {locale: 'english'}]) {
    assert.throws(() => checkCaptureInput({...baseInput('https://a.example.com/'), runtime, ...bad}), /invalid capture input/, JSON.stringify(bad));
  }
  const options = camoufoxOptions({executablePath: '/opt/camoufox/camoufox', modelDir: '/opt/camoufox/model'},
    {relay: 'http://127.0.0.1:4000', cacheDir: '/tmp/x', locale: 'en-IN', timezone: 'Asia/Kolkata'});
  assert.deepEqual(options.proxy, {server: 'http://127.0.0.1:4000', bypass: ''});
  assert.equal(options.firefox_user_prefs['network.proxy.failover_direct'], false);
  assert.equal(options.firefox_user_prefs['network.trr.mode'], 5);
  assert.equal(options.locale, 'en-IN');
  assert.throws(() => camoufoxOptions({}, {relay: 'http://10.0.0.1:4000', cacheDir: '/tmp'}), {code: 'browser_proxy_required'});
  assert.deepEqual(browserRuntime({}), {available: false, reason: 'browser_unavailable'});
  assert.equal(browserRuntime({browser: {camoufox: {version: 'old', sha256: 'a'.repeat(64)}}}).reason, 'browser_runtime_unqualified');
  assert.equal(browserRuntime({browser: {camoufox: {version: CAMOUFOX_PIN.version, sha256: 'a'.repeat(64)}}}).runtime.engine, 'camoufox');
});

test('browser slots report queue metrics for the autoscaler', async () => {
  const {BrowserSlots} = await import('../src/browser/queue.mjs');
  const slots = new BrowserSlots({localConcurrency: 1, runner: async () => ({})});
  const first = await slots.acquire({}, {deadline: Date.now() + 5000});
  assert.deepEqual(slots.metrics(), {pending: 0, active: 1, oldest_wait_ms: 0, recent_timeouts: 0});
  const waiting = slots.acquire({}, {deadline: Date.now() + 5000});
  await new Promise(resolve => setTimeout(resolve, 20));
  const busy = slots.metrics();
  assert.equal(busy.pending, 1);
  assert.ok(busy.oldest_wait_ms >= 10);
  first.release();
  const second = await waiting;
  assert.deepEqual(slots.metrics(), {pending: 0, active: 1, oldest_wait_ms: 0, recent_timeouts: 0});
  await assert.rejects(slots.acquire({}, {deadline: Date.now() + 100}), {code: 'browser_capacity'});
  assert.equal(slots.metrics().recent_timeouts, 1);
  second.release();
  assert.equal(slots.metrics().active, 0);
});
