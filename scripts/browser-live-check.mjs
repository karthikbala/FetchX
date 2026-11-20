// Operator check of the real browser path against a live site, without the
// gateway: Camoufox from the pinned bundle, through one residential session,
// with the same capture code, warm-up, self-clear wait, exit-IP placement and
// kept device identity that browser steps use. For release qualification and
// for checking how a protected site responds before and after a change.
//
// Run inside the gateway image, with network, as the gateway user:
//   docker run --rm --user 10001:10001 --shm-size 512m -e HOME=/tmp \
//     -v <browser bundle>:/opt/gateway-browser:ro -v <pin dir>:/run/fx/pin:ro \
//     -v <gateway.json>:/run/secrets/gateway.json:ro <image> \
//     node scripts/browser-live-check.mjs [--provider dataimpulse] [--country US] [--draws 3] \
//       [--follow <regex of links to visit next>] [--follow-max 3] [--no-warmup] [--fonts]
//       [--probe [--probe-seconds 20] [--count <css selector>]...] <url> [<url> ...]
//
// Visits each URL in order on one session (one exit IP, one device identity),
// a fresh browser per page and 4-6 s apart, as consecutive requests to FetchX
// would. A page that stays walled ends the session; the next draw starts over
// on a fresh one. Prints one JSON line per page: status, title, sizes, wall and
// warm-up outcomes. Proxy credentials are read from gateway.json and never printed.
// Each page has a hard limit (the capture deadline plus 30 s): a browser that
// stops answering is closed and the page reported as `hung`.
//
// --fonts also prints, once per draw, which fonts a page can detect, measured as
// fingerprinting scripts do (canvas text widths against the generic fallbacks;
// a fontconfig alias counts as present, as it does for them). The persona's
// Windows fonts should be there; fonts that exist only in the gateway image or
// in another OS's bundle should not, and the control must read as absent.
//
// --probe watches how a page fills itself in instead of capturing it: once a
// second for --probe-seconds after the document loads, then a screen at a time
// as it is scrolled to the bottom, it prints the element count, page height,
// scroll position, text length, the page's open and started data requests
// (XHR, fetch), proxy kilobytes so far, and how many elements match each
// --count selector. It also lists the hosts the page's data requests went to
// (host names only). For deciding how capture should wait for, and scroll,
// pages that load their content by script.
import http from 'node:http';
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import {lookup} from 'node:dns/promises';
import {randomBytes} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {launchCamoufox} from '../src/browser/engine.mjs';
import {capturePage} from '../src/browser/capture.mjs';
import {ExitGeo} from '../src/fetch/exit-geo.mjs';
import {residentialProxy} from '../src/fetch/routes.mjs';
import {browserPlace} from '../src/fetch/browser-attempt.mjs';
import {checkAddresses} from '../src/fetch/destination.mjs';
import {checkCaptureInput} from '../src/browser/capture-input.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const [, value] = args.splice(index, 2);
  return value;
};
const flag = name => {
  const index = args.indexOf(name);
  if (index >= 0) args.splice(index, 1);
  return index >= 0;
};
const provider = option('--provider', 'dataimpulse');
const country = option('--country', 'US');
const draws = Number(option('--draws', '3'));
const follow = option('--follow', null);
const followMax = Number(option('--follow-max', '3'));
const warmup = !flag('--no-warmup');
const fontCheck = flag('--fonts');
const probe = flag('--probe');
const probeSeconds = Number(option('--probe-seconds', '20'));
const counts = [];
for (let selector = option('--count', null); selector !== null; selector = option('--count', null)) counts.push(selector);
const urls = args.filter(arg => /^https:\/\//.test(arg));
if (!urls.length) {
  console.error('usage: node scripts/browser-live-check.mjs [options] <https url> [...]');
  process.exit(64);
}

const config = JSON.parse(await readFile(process.env.GATEWAY_CONFIG ?? '/run/secrets/gateway.json', 'utf8'));
const runtime = JSON.parse(await readFile(process.env.FETCHX_WORKER_RUNTIME ?? '/run/fx/pin/runtime.json', 'utf8'));
const resolve = async url => checkAddresses(await lookup(url.hostname, {all: true, verbatim: true}));
const exitGeo = new ExitGeo(config, {resolve});

// A loopback CONNECT relay to the residential proxy: Camoufox only accepts a
// loopback proxy, as in production.
function startRelay(upstream) {
  const target = new URL(upstream);
  const stats = {bytes: 0};
  const count = chunk => { stats.bytes += chunk.length; };
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString('base64');
  const server = http.createServer((_req, res) => res.writeHead(403).end());
  server.on('connect', (req, client, head) => {
    const remote = net.connect(Number(target.port) || 80, target.hostname, () => {
      remote.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    });
    let reply = Buffer.alloc(0);
    const onData = chunk => {
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf('\r\n\r\n');
      if (end < 0) return;
      remote.off('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(reply.toString('latin1'))) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        remote.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (reply.length > end + 4) client.write(reply.subarray(end + 4));
      if (head.length) remote.write(head);
      stats.bytes += reply.length - end - 4 + head.length;
      remote.on('data', count);
      client.on('data', count);
      remote.pipe(client).on('error', () => {});
      client.pipe(remote).on('error', () => {});
    };
    remote.on('data', onData);
    remote.on('error', () => client.destroy());
    client.on('error', () => remote.destroy());
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({url: `http://127.0.0.1:${server.address().port}/`, stats,
    close: () => new Promise(closed => { server.closeAllConnections?.(); server.close(closed); })})));
}

const FONTS = {
  // Windows persona fonts: expected.
  windows: ['Arial', 'Segoe UI', 'Calibri', 'Times New Roman', 'Consolas', 'Tahoma'],
  // Only in the gateway image's own /usr/share/fonts: a leak if rendered.
  image: ['FreeSans', 'FreeSerif', 'FreeMono', 'WenQuanYi Zen Hei', 'WenQuanYi Micro Hei', 'Unifont'],
  // Only in the bundle's macOS or Linux groups: a leak for a Windows persona.
  other_os: ['Helvetica Neue', 'Menlo', 'Monaco', 'Geneva', 'Ubuntu', 'Cantarell'],
  // Exists nowhere: must read as absent, or the method is unreliable.
  control: ['FxNoSuchFont Regular'],
};

// Which of the names render differently from at least one generic fallback.
async function renderableFonts(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<!doctype html><title>fonts</title>');
    return await page.evaluate(groups => {
      const canvas = document.createElement('canvas').getContext('2d');
      const text = 'mmmmmmmmmmlli1WwQ@#&\u00fc\u4e2d\u6587';
      const width = font => { canvas.font = `72px ${font}`; return canvas.measureText(text).width; };
      const generics = ['monospace', 'serif', 'sans-serif'];
      const base = Object.fromEntries(generics.map(name => [name, width(name)]));
      const seen = name => generics.some(generic => width(`"${name}", ${generic}`) !== base[generic]);
      return Object.fromEntries(Object.entries(groups).map(([group, names]) => [group, names.filter(seen)]));
    }, FONTS);
  } finally {
    await context.close().catch(() => {});
  }
}

// The promise's value, or null if it takes longer than ms (page.evaluate has no timeout).
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise.catch(() => null), new Promise(done => { timer = setTimeout(done, ms, null); })]);
  } finally {
    clearTimeout(timer);
  }
}

// --probe: how the page fills itself in over time and as it is scrolled.
async function probePage(browser, url, place, relay, log) {
  const context = await browser.newContext({serviceWorkers: 'block', locale: place.locale, timezoneId: place.timezone, viewport: null});
  try {
    await context.routeWebSocket?.('**/*', ws => ws.close());
    const page = await context.newPage();
    const open = new Map();
    const hosts = new Map();
    let started = 0;
    page.on('request', request => {
      try {
        if (!['xhr', 'fetch'].includes(request.resourceType())) return;
        open.set(request, Date.now());
        started++;
        const host = new URL(request.url()).hostname;
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
      } catch { /* closed */ }
    });
    const done = request => open.delete(request);
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    const target = new URL(url);
    let referer;
    if (warmup && (target.pathname !== '/' || target.search)) {
      await page.goto(new URL('/', target).href, {waitUntil: 'domcontentloaded', timeout: 30_000}).catch(() => null);
      await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
      referer = page.url();
    }
    const response = await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30_000, ...(referer ? {referer} : {})}).catch(() => null);
    const loadedAt = Date.now();
    const sample = async label => {
      const seen = await within(page.evaluate(selectors => ({
        elements: document.getElementsByTagName('*').length, height: document.documentElement.scrollHeight,
        view: innerHeight, y: Math.round(scrollY), text: document.body?.innerText.length ?? 0,
        counts: selectors.map(selector => { try { return document.querySelectorAll(selector).length; } catch { return -1; } }),
      }), counts), 3000);
      const now = Date.now();
      return {t: Math.round((now - loadedAt) / 100) / 10, label, ...(seen ?? {unanswered: true}),
        open: [...open.values()].filter(at => now - at < 5000).length, open_long: [...open.values()].filter(at => now - at >= 5000).length,
        started, kb: Math.round(relay.stats.bytes / 1024)};
    };
    // Each sample is printed as it is taken: a page cut off by the hard limit still leaves its data.
    const samples = [];
    const take = async label => {
      const taken = await sample(label);
      samples.push(taken);
      log(taken);
      return taken;
    };
    await take('loaded');
    for (let second = 1; second <= probeSeconds; second++) {
      await page.waitForTimeout(1000);
      await take('wait');
    }
    const title = await within(page.title(), 3000);
    const walledPage = !response || response.status() >= 400 || /^(bot or not|just a moment|access denied)/i.test(title ?? '');
    if (!walledPage) {
      const box = samples.at(-1);
      await page.mouse.move(Math.round((box.view ?? 800) * 0.6), Math.round((box.view ?? 800) * 0.5), {steps: 4}).catch(() => {});
      let still = 0;
      for (let screen = 1; screen <= PROBE_MAX_SCREENS && still < 3; screen++) {
        const before = samples.at(-1);
        await page.mouse.wheel(0, Math.round((before.view ?? 800) * (0.75 + Math.random() * 0.2))).catch(() => {});
        await page.waitForTimeout(1500);
        const after = await take(`screen ${screen}`);
        const atBottom = after.y + (after.view ?? 0) >= (after.height ?? 0) - 2;
        still = atBottom && after.height === before.height ? still + 1 : 0;
      }
    }
    return {status: response?.status() ?? null, title, samples: samples.length,
      data_hosts: Object.fromEntries([...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))};
  } finally {
    await context.close().catch(() => {});
  }
}

const PAGE_DEADLINE_MS = 120_000;
const PROBE_MAX_SCREENS = 30;
// A probe loads two pages, watches for probeSeconds and scrolls up to PROBE_MAX_SCREENS (each up to 4.5 s).
const HARD_LIMIT_MS = probe ? 90_000 + probeSeconds * 4000 + PROBE_MAX_SCREENS * 4500 : PAGE_DEADLINE_MS + 30_000;

async function visit(url, options) {
  // A browser call can stay pending after the browser is gone (Camoufox), with
  // nothing left to keep Node running; the race and the timer end the page instead.
  let limit;
  const cutOff = new Promise(done => {
    limit = setTimeout(done, HARD_LIMIT_MS + 15_000, {summary: {status: null, error: 'hung', secs: Math.round((HARD_LIMIT_MS + 15_000) / 1000)},
      links: [], fingerprint: null, rendered: null});
  });
  try {
    return await Promise.race([visitPage(url, options), cutOff]);
  } finally {
    clearTimeout(limit);
  }
}

async function visitPage(url, {proxy, geo, fingerprint, fonts = false, log = () => {}}) {
  const relay = await startRelay(proxy.url);
  const place = browserPlace({country}, geo);
  const started = Date.now();
  let server;
  let browser;
  let drawn;
  let hung = false;
  let dom = Buffer.alloc(0);
  // Closing the browser makes every pending call fail, so a hung page ends.
  const guard = setTimeout(() => {
    hung = true;
    browser?.close().catch(() => {});
  }, HARD_LIMIT_MS);
  try {
    ({server, browser, fingerprint: drawn} = await launchCamoufox(runtime, {relay: relay.url, cacheDir: process.env.HOME ?? '/tmp',
      locale: place.locale, timezone: place.timezone, geolocation: place.geolocation, fingerprint}));
    const rendered = fonts ? await renderableFonts(browser).catch(error => ({error: error.message.slice(0, 120)})) : null;
    if (probe) {
      const report = await probePage(browser, url, place, relay, log);
      return {summary: {...report, error: hung ? 'hung' : null, secs: Math.round((Date.now() - started) / 1000)}, links: [], fingerprint: drawn, rendered};
    }
    const input = {url, deadline: Date.now() + PAGE_DEADLINE_MS, warmup, self_clear_ms: 45_000, settle_ms: 750,
      limits: {max_requests: 500, max_dom_bytes: 10_000_000, max_body_bytes: 10_000_000}, screenshot: false, captcha: false,
      headers: {}, cookies: [], locale: place.locale, timezone: place.timezone};
    // What a pool worker would be sent for this page, kept identity included: it must pass the worker's check.
    checkCaptureInput({...input, runtime: {engine: 'camoufox'}, ...(place.geolocation ? {geolocation: place.geolocation} : {}),
      ...(fingerprint ? {fingerprint} : {})});
    const result = await capturePage(browser, input,
    {admit: async meta => {
      if (!/^https:/.test(meta.url)) throw Object.assign(new Error('x'), {code: 'insecure_request'});
      if (!['GET', 'HEAD', 'POST'].includes(meta.method)) throw Object.assign(new Error('x'), {code: 'method_refused'});
    }, artifact: async data => { if (data.kind === 'dom') dom = Buffer.from(data.body_base64, 'base64'); }});
    const html = dom.toString('utf8');
    const title = /<title[^>]*>([^<]{0,120})/i.exec(html)?.[1]?.trim() ?? null;
    const links = follow ? [...new Set([...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]).filter(href => new RegExp(follow).test(href))
      .map(href => new URL(href.replace(/&amp;/g, '&'), url).href))] : [];
    return {summary: {status: result.status, title, dom_bytes: result.dom_bytes, requests: result.requests, blocked: result.blocked,
      blocked_reasons: result.blocked_reasons, warmup: result.warmup, wall: result.wall, error: hung ? 'hung' : result.error,
      secs: Math.round((Date.now() - started) / 1000)}, links, fingerprint: drawn, rendered};
  } catch (error) {
    return {summary: {status: null, error: hung ? 'hung' : (error.code ?? error.message ?? 'failed').slice(0, 120),
      secs: Math.round((Date.now() - started) / 1000)}, links: [], fingerprint: drawn, rendered: null};
  } finally {
    clearTimeout(guard);
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    await relay.close();
  }
}

const walled = summary => summary.status === null || [403, 429].includes(summary.status) || summary.warmup === 'challenged'
  || (summary.wall && !summary.wall.cleared) || /^(bot or not|just a moment|access denied|pardon our interruption)/i.test(summary.title ?? '');

for (let draw = 1; draw <= draws; draw++) {
  const proxy = residentialProxy(config, provider, country, randomBytes(5).toString('hex'));
  const geo = await exitGeo.lookup(proxy);
  console.log(JSON.stringify({draw, exit: geo ? {ip: geo.ip.replace(/[.:][0-9a-f]+$/i, '.x'), tz: geo.timezone, country: geo.country} : null}));
  let fingerprint = null;
  const queue = [...urls];
  let followed = 0;
  let burned = false;
  while (queue.length) {
    const url = queue.shift();
    const kept = !!fingerprint;
    const {summary, links, fingerprint: drawn, rendered} = await visit(url, {proxy, geo, fingerprint, fonts: fontCheck && !kept,
      log: sample => console.log(JSON.stringify({draw, url: url.slice(0, 100), sample}))});
    fingerprint ??= drawn;
    if (rendered) console.log(JSON.stringify({draw, fonts: rendered}));
    console.log(JSON.stringify({draw, url: url.slice(0, 100), kept_identity: kept, ...summary, followable: links.length}));
    if (walled(summary)) { burned = true; break; }
    for (const link of links) if (followed < followMax && !queue.includes(link) && !urls.includes(link)) { queue.push(link); followed++; }
    if (queue.length) await sleep(4000 + Math.floor(Math.random() * 2000));
  }
  if (!burned) break;
  if (draw < draws) await sleep(30_000);
}
