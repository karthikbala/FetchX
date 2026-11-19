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
//       [--follow <regex of links to visit next>] [--follow-max 3] [--no-warmup] <url> [<url> ...]
//
// Visits each URL in order on one session (one exit IP, one device identity),
// a fresh browser per page and 4-6 s apart, as consecutive requests to FetchX
// would. A page that stays walled ends the session; the next draw starts over
// on a fresh one. Prints one JSON line per page: status, title, sizes, wall and
// warm-up outcomes. Proxy credentials are read from gateway.json and never printed.
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
      remote.pipe(client).on('error', () => {});
      client.pipe(remote).on('error', () => {});
    };
    remote.on('data', onData);
    remote.on('error', () => client.destroy());
    client.on('error', () => remote.destroy());
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise(closed => { server.closeAllConnections?.(); server.close(closed); })})));
}

async function visit(url, {proxy, geo, fingerprint}) {
  const relay = await startRelay(proxy.url);
  const place = browserPlace({country}, geo);
  const started = Date.now();
  let server;
  let browser;
  let drawn;
  let dom = Buffer.alloc(0);
  try {
    ({server, browser, fingerprint: drawn} = await launchCamoufox(runtime, {relay: relay.url, cacheDir: process.env.HOME ?? '/tmp',
      locale: place.locale, timezone: place.timezone, geolocation: place.geolocation, fingerprint}));
    const result = await capturePage(browser, {url, deadline: Date.now() + 120_000, warmup, self_clear_ms: 45_000, settle_ms: 750,
      limits: {max_requests: 500, max_dom_bytes: 10_000_000, max_body_bytes: 10_000_000}, screenshot: false, captcha: false,
      headers: {}, cookies: [], locale: place.locale, timezone: place.timezone},
    {admit: async meta => {
      if (!/^https:/.test(meta.url)) throw Object.assign(new Error('x'), {code: 'insecure_request'});
      if (!['GET', 'HEAD', 'POST'].includes(meta.method)) throw Object.assign(new Error('x'), {code: 'method_refused'});
    }, artifact: async data => { if (data.kind === 'dom') dom = Buffer.from(data.body_base64, 'base64'); }});
    const html = dom.toString('utf8');
    const title = /<title[^>]*>([^<]{0,120})/i.exec(html)?.[1]?.trim() ?? null;
    const links = follow ? [...new Set([...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]).filter(href => new RegExp(follow).test(href))
      .map(href => new URL(href.replace(/&amp;/g, '&'), url).href))] : [];
    return {summary: {status: result.status, title, dom_bytes: result.dom_bytes, requests: result.requests, blocked: result.blocked,
      blocked_reasons: result.blocked_reasons, warmup: result.warmup, wall: result.wall, error: result.error,
      secs: Math.round((Date.now() - started) / 1000)}, links, fingerprint: drawn};
  } finally {
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
    const {summary, links, fingerprint: drawn} = await visit(url, {proxy, geo, fingerprint});
    fingerprint ??= drawn;
    console.log(JSON.stringify({draw, url: url.slice(0, 100), kept_identity: kept, ...summary, followable: links.length}));
    if (walled(summary)) { burned = true; break; }
    for (const link of links) if (followed < followMax && !queue.includes(link) && !urls.includes(link)) { queue.push(link); followed++; }
    if (queue.length) await sleep(4000 + Math.floor(Math.random() * 2000));
  }
  if (!burned) break;
  if (draw < draws) await sleep(30_000);
}
