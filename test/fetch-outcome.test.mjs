import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyResponse, detectChallenge, isJavaScriptShell, retryAfterSeconds} from '../src/fetch/outcome.mjs';
import {deriveOutputs} from '../src/fetch/outputs.mjs';
import {fixHeaders, checkHeaders, BROWSER_USER_AGENT} from '../src/fetch/http-attempt.mjs';

const html = {'content-type': 'text/html; charset=utf-8'};
const page = body => ({status: 200, headers: html, body: Buffer.from(body)});

test('status codes map to outcomes; a challenge page is a block whatever its status', () => {
  assert.equal(classifyResponse(page('<html><body><h1>Hello</h1><p>' + 'text '.repeat(100) + '</p></body></html>')).outcome, 'success');
  assert.equal(classifyResponse({status: 404, headers: html, body: Buffer.from('nope')}).outcome, 'answered');
  assert.equal(classifyResponse({status: 410, headers: {}, body: Buffer.alloc(0)}).outcome, 'answered');
  assert.equal(classifyResponse({status: 403, headers: html, body: Buffer.from('denied')}).outcome, 'blocked');
  assert.equal(classifyResponse({status: 401, headers: {}, body: Buffer.alloc(0)}).outcome, 'login_required');
  assert.equal(classifyResponse({status: 429, headers: {}, body: Buffer.alloc(0)}).outcome, 'rate_limited');
  assert.equal(classifyResponse({status: 503, headers: {}, body: Buffer.alloc(0)}).outcome, 'site_error');
  const challenge = classifyResponse({status: 429, headers: html, body: Buffer.from("<title>Just a moment...</title><script>window._cf_chl_opt={}</script>")});
  assert.deepEqual(challenge, {outcome: 'blocked', challenge: {vendor: 'cloudflare'}});
  assert.equal(classifyResponse(page('<title>Robot check</title>')).outcome, 'blocked');
});

test('vendors are named from generic fingerprints, and comments are not challenges', () => {
  assert.equal(detectChallenge({status: 403, headers: html, body: '<iframe src="https://geo.captcha-delivery.com/captcha/?t=fe"></iframe>'}).vendor, 'datadome');
  assert.equal(detectChallenge({status: 403, headers: html, body: "<script>var dd={'cid':'abc','hsh':'x'}</script>"}).vendor, 'datadome');
  assert.equal(detectChallenge({status: 200, headers: {'cf-mitigated': 'challenge'}, body: ''}).vendor, 'cloudflare');
  assert.equal(detectChallenge({status: 405, headers: {'x-amzn-waf-action': 'captcha'}, body: ''}).vendor, 'aws_waf');
  assert.equal(detectChallenge({status: 403, headers: html, body: '<script src="//captcha.px-cdn.net/x.js"></script>'}).vendor, 'human');
  assert.equal(detectChallenge({status: 200, headers: html, body: '<!-- verify you are human --><p>Help article</p>'}), null);
  assert.equal(detectChallenge({status: 200, headers: html, body: '<pre>verify you are human</pre>'}), null);
  assert.equal(detectChallenge({status: 200, headers: {'content-type': 'application/json'}, body: '{"title":"Just a moment"}'}), null);
});

test('a JavaScript shell over HTTP asks for a browser', () => {
  const shell = '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
  assert.equal(isJavaScriptShell({headers: html, body: shell}), true);
  assert.equal(classifyResponse({status: 200, headers: html, body: Buffer.from(shell)}).outcome, 'needs_browser');
  assert.equal(classifyResponse({status: 200, headers: html, body: Buffer.from(shell)}, {transport: 'browser'}).outcome, 'success');
  assert.equal(isJavaScriptShell({headers: html, body: '<html><body><div id="root"><h1>Real content</h1>' + 'words '.repeat(80) + '</div><script></script></body></html>'}), false);
});

test('Retry-After is read and capped', () => {
  assert.equal(retryAfterSeconds({'retry-after': '120'}), 120);
  assert.equal(retryAfterSeconds({'retry-after': '99999'}), 3600);
  assert.equal(retryAfterSeconds({}), null);
});

test('formats are derived from the sanitised page', () => {
  const body = Buffer.from(`<html lang="en"><head><title>Product</title><meta name="description" content="A thing">
    <meta property="og:image" content="https://cdn.example/p.jpg"><link rel="canonical" href="/p/1"></head>
    <body><nav>Menu</nav><main><h1>Widget</h1><p>Costs <b>$5</b>. <a href="/buy">Buy</a></p>
    <script>steal()</script><form><input name="q"></form></main></body></html>`);
  const out = deriveOutputs({body, contentType: 'text/html', finalUrl: 'https://shop.example/p/1?ref=x', headers: {}},
    ['markdown', 'text', 'links', 'metadata', 'json', 'screenshot']);
  assert.deepEqual(out.metadata, {title: 'Product', description: 'A thing', canonical_url: 'https://shop.example/p/1', language: 'en',
    open_graph: {image: 'https://cdn.example/p.jpg'}});
  assert.deepEqual(out.links, [{url: 'https://shop.example/buy', text: 'Buy'}]);
  assert.match(out.markdown, /# Widget/);
  assert.match(out.markdown, /\[Buy\]\(https:\/\/shop\.example\/buy\)/);
  assert.ok(!out.markdown.includes('steal') && !out.text.includes('steal'));
  assert.equal(out.text, 'Menu\nWidget\nCosts $5. Buy');
  assert.equal(out.json, null);
  assert.equal('screenshot' in out, false);
  assert.deepEqual(deriveOutputs({body: Buffer.from('{"a":1}'), contentType: 'application/json', finalUrl: 'https://x.example/', headers: {}}, ['json', 'links']),
    {json: {a: 1}, links: []});
  assert.deepEqual(deriveOutputs({body: Buffer.from('plain'), contentType: 'text/plain', finalUrl: 'https://x.example/', headers: {}}, ['text', 'markdown']),
    {text: 'plain', markdown: 'plain'});
});

test('client mistakes are fixed; caller headers otherwise pass through', () => {
  const {headers, fixed} = fixHeaders(checkHeaders({'User-Agent': 'python-requests/2.32', Authorization: 'Bearer site-token'}));
  assert.equal(headers['user-agent'], BROWSER_USER_AGENT);
  assert.equal(headers.authorization, 'Bearer site-token');
  assert.deepEqual(fixed, ['user-agent', 'accept', 'accept-language']);
  assert.deepEqual(fixHeaders({'user-agent': 'MyApp/1.0 (contact@example.com)', accept: '*/*', 'accept-language': 'fr'}).fixed, []);
});
