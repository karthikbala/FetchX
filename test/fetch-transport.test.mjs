import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {gzipSync} from 'node:zlib';
import {exchange} from '../src/fetch/transport.mjs';
import {httpAttempt} from '../src/fetch/http-attempt.mjs';
import {GatewayError} from '../src/policy.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

// A CONNECT proxy like a provider's: checks Basic auth, then pipes bytes.
async function proxyServer({status = 200} = {}) {
  const seen = [];
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  server.on('connect', (req, client, head) => {
    seen.push({target: req.url, auth: req.headers['proxy-authorization'] ?? null});
    if (status !== 200) return client.end(`HTTP/1.1 ${status} No\r\n\r\n`);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
  });
  const port = await listen(server);
  return {server, seen, url: `http://user%40x:pa%24s@127.0.0.1:${port}/`};
}

test('direct and proxied exchanges meter every byte and pin the checked address', async t => {
  const site = http.createServer((req, res) => {
    if (req.url === '/big') return res.end('x'.repeat(5000));
    res.setHeader('content-encoding', 'gzip');
    res.setHeader('content-type', 'text/plain');
    res.end(gzipSync(Buffer.from(`hello ${req.method} ${req.headers['user-agent']}`)));
  });
  const port = await listen(site);
  const proxy = await proxyServer();
  t.after(async () => { await close(site); await close(proxy.server); });
  // The URL names a host that does not resolve; the pinned address is used.
  const destination = {url: new URL(`http://pinned.invalid:${port}/`), address: '127.0.0.1', family: 4};
  const limits = {timeoutMs: 5000, maxBodyBytes: 10_000, maxWireBytes: 100_000};
  const direct = await exchange({method: 'GET', headers: {'user-agent': 'UA'}}, destination, limits);
  assert.equal(direct.status, 200);
  assert.ok(direct.wire_bytes > direct.encoded.length);
  const viaProxy = await exchange({method: 'GET', headers: {'user-agent': 'UA'}}, destination, limits, {proxy: {url: proxy.url}});
  assert.equal(viaProxy.status, 200);
  assert.equal(viaProxy.provider_status, 200);
  assert.deepEqual(proxy.seen[0], {target: `127.0.0.1:${port}`, auth: 'Basic ' + Buffer.from('user@x:pa$s').toString('base64')});
  assert.ok(viaProxy.wire_bytes > direct.wire_bytes, 'the CONNECT exchange is metered too');
  await assert.rejects(exchange({method: 'GET', headers: {}}, {...destination, url: new URL(`http://pinned.invalid:${port}/big`)},
    {...limits, maxBodyBytes: 1000}), {code: 'too_large'});
  // Decoding happens in httpAttempt. It refuses a private answer from any
  // resolver, so the test resolves to a public address and dials the local site.
  const local = (request, target, limits) => exchange(request, {...target, address: '127.0.0.1'}, limits);
  const attempt = await httpAttempt({url: new URL(`http://pinned.invalid:${port}/`), method: 'GET', headers: {'user-agent': 'UA'}},
    {proxy: null, resolve: async () => [{address: '93.184.216.34', family: 4}]}, {deadline: Date.now() + 5000, maxBodyBytes: 10_000, maxWireBytes: 100_000},
    {exchangeImpl: local});
  assert.equal(attempt.body.toString(), 'hello GET UA');
  await assert.rejects(httpAttempt({url: new URL(`http://pinned.invalid:${port}/`), method: 'GET', headers: {}},
    {proxy: null, resolve: async () => [{address: '127.0.0.1', family: 4}]}, {deadline: Date.now() + 5000, maxBodyBytes: 10_000, maxWireBytes: 100_000}),
  {code: 'url_not_allowed'}, 'a resolver cannot hand back a private address');
});

test('a provider refusal is a provider fault and nothing reached the site', async t => {
  const proxy = await proxyServer({status: 407});
  t.after(() => close(proxy.server));
  await assert.rejects(exchange({method: 'GET', headers: {}}, {url: new URL('http://site.invalid/'), address: '127.0.0.1', family: 4},
    {timeoutMs: 3000, maxBodyBytes: 1000, maxWireBytes: 10_000}, {proxy: {url: proxy.url}}),
  error => error.code === 'provider_account_rejected' && error.dispatched === false);
  await assert.rejects(exchange({method: 'GET', headers: {}}, {url: new URL('http://site.invalid/'), address: '127.0.0.1', family: 4},
    {timeoutMs: 3000, maxBodyBytes: 1000, maxWireBytes: 10_000}, {proxy: {url: 'http://127.0.0.1:1/'}}),
  error => ['proxy_connect_refused', 'proxy_connect_failed'].includes(error.code) && error.dispatched === false);
});

test('redirects are re-checked, keep cookies, and drop credentials when they leave the origin', async () => {
  const sent = [];
  const exchangeImpl = async (request, destination) => {
    sent.push({url: destination.url.href, method: request.method, headers: request.headers, body: request.body});
    const path = destination.url.pathname;
    if (path === '/login') return {status: 302, headers: {location: '/home', 'set-cookie': ['sid=abc; Path=/']}, encoded: Buffer.alloc(0)};
    if (path === '/home') return {status: 301, headers: {location: 'https://cdn.example.com/page'}, encoded: Buffer.alloc(0)};
    if (path === '/private') return {status: 302, headers: {location: 'http://127.0.0.1/admin'}, encoded: Buffer.alloc(0)};
    if (path === '/loop') return {status: 302, headers: {location: '/loop'}, encoded: Buffer.alloc(0)};
    return {status: 200, headers: {'content-type': 'text/plain'}, encoded: Buffer.from('done')};
  };
  const options = {proxy: null, resolve: async () => [{address: '93.184.216.34', family: 4}]};
  const limits = () => ({deadline: Date.now() + 5000, maxBodyBytes: 1000, maxWireBytes: 100_000});
  const result = await httpAttempt({url: new URL('https://shop.example.com/login'), method: 'POST', body: Buffer.from('a=1'),
    headers: {authorization: 'Bearer site', 'x-trace': '1'}}, options, limits(), {exchangeImpl});
  assert.equal(result.final_url, 'https://cdn.example.com/page');
  assert.equal(result.redirects, 2);
  assert.deepEqual(sent.map(s => [s.method, s.url]), [['POST', 'https://shop.example.com/login'], ['GET', 'https://shop.example.com/home'],
    ['GET', 'https://cdn.example.com/page']]);
  assert.equal(sent[1].headers.cookie, 'sid=abc');
  assert.equal(sent[1].headers.authorization, 'Bearer site');
  assert.equal(sent[2].headers.authorization, undefined, 'credentials stay with their origin');
  assert.equal(sent[2].headers['x-trace'], '1');
  assert.equal(sent[1].body, null);
  await assert.rejects(httpAttempt({url: new URL('https://shop.example.com/private'), method: 'GET', headers: {}}, options, limits(), {exchangeImpl}),
    {code: 'url_not_allowed'});
  await assert.rejects(httpAttempt({url: new URL('https://shop.example.com/loop'), method: 'GET', headers: {}}, options, limits(), {exchangeImpl}),
    error => error instanceof GatewayError && error.code === 'too_many_redirects' && error.dispatched === true);
});
