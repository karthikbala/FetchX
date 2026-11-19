import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFetchRequest, needsBrowser} from '../src/fetch/request.mjs';
import {checkUrl, checkRedirect, checkAddresses, isPublicAddress} from '../src/fetch/destination.mjs';

const refused = (raw, field) => assert.throws(() => parseFetchRequest(raw), error => {
  assert.equal(error.code, raw?.url && field === 'url' ? 'url_not_allowed' : 'invalid_request', JSON.stringify(raw));
  if (field) assert.equal(error.details?.field, field, JSON.stringify(raw));
  return true;
});

test('a bare URL gets every default', () => {
  const {request, idempotencyKey, generatedKey, hash} = parseFetchRequest({url: 'https://Example.com/a?b=1#frag'});
  assert.equal(request.url, 'https://example.com/a?b=1');
  assert.deepEqual({method: request.method, render: request.render, formats: request.formats, include_body: request.include_body,
    max_attempts: request.max_attempts, fix_headers: request.fix_headers, timeout_ms: request.timeout_ms, async: request.async,
    route: request.route, country: request.country, max_credits: request.max_credits},
  {method: 'GET', render: 'auto', formats: [], include_body: true, max_attempts: 5, fix_headers: true, timeout_ms: 60000,
    async: false, route: null, country: null, max_credits: null});
  assert.ok(generatedKey && idempotencyKey.startsWith('auto_'));
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test('the same request hashes the same; key order and format order do not matter', () => {
  const a = parseFetchRequest({url: 'https://example.com/', formats: ['text', 'markdown'], idempotency_key: 'k1'});
  const b = parseFetchRequest({idempotency_key: 'k2', formats: ['markdown', 'text'], url: 'https://example.com/'});
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, parseFetchRequest({url: 'https://example.com/', formats: ['text']}).hash);
});

test('every field is validated and refusals name the field', () => {
  refused({url: 'https://example.com/', surprise: 1}, 'surprise');
  refused({}, 'url');
  refused({url: 'https://example.com/', method: 'TRACE'}, 'method');
  refused({url: 'https://example.com/', headers: {Host: 'x'}}, 'headers');
  refused({url: 'https://example.com/', headers: {'X-Forwarded-For': '1.2.3.4'}}, 'headers');
  refused({url: 'https://example.com/', body: 'x'}, 'body');
  refused({url: 'https://example.com/', method: 'POST', body: 'x', body_base64: 'eA=='}, 'body');
  refused({url: 'https://example.com/', render: 'sometimes'}, 'render');
  refused({url: 'https://example.com/', formats: ['pdf']}, 'formats');
  refused({url: 'https://example.com/', formats: ['text', 'text']}, 'formats');
  refused({url: 'https://example.com/', wait_for: {ms: 20000}}, 'wait_for.ms');
  refused({url: 'https://example.com/', wait_for: {}}, 'wait_for');
  refused({url: 'https://example.com/', country: 'usa'}, 'country');
  refused({url: 'https://example.com/', route: {class: 'mobile'}}, 'route.class');
  refused({url: 'https://example.com/', route: {class: 'residential'}}, 'route.country');
  refused({url: 'https://example.com/', route: {class: 'direct', country: 'US'}}, 'route.country');
  refused({url: 'https://example.com/', max_attempts: 6}, 'max_attempts');
  refused({url: 'https://example.com/', max_credits: 0}, 'max_credits');
  refused({url: 'https://example.com/', timeout_ms: 1000}, 'timeout_ms');
  refused({url: 'https://example.com/', webhook_url: 'http://hooks.example.com/'}, 'webhook_url');
  refused({url: 'https://example.com/', webhook_url: 'https://127.0.0.1/'}, 'webhook_url');
  refused({url: 'https://example.com/', tags: ['a b']}, 'tags');
  refused({url: 'https://example.com/', idempotency_key: 'has space'}, 'idempotency_key');
  // Browser-only options need GET.
  refused({url: 'https://example.com/', method: 'POST', render: 'always'}, 'render');
  refused({url: 'https://example.com/', method: 'POST', formats: ['screenshot']}, 'formats');
  refused({url: 'https://example.com/', render: 'never', formats: ['screenshot']}, 'render');
  assert.throws(() => parseFetchRequest({url: 'https://example.com/', method: 'POST', body: 'x'.repeat(1_000_001)}),
    {code: 'request_too_large'});
});

test('browser needs follow from render, wait_for, screenshot and route', () => {
  const need = raw => needsBrowser(parseFetchRequest({url: 'https://example.com/', ...raw}).request);
  assert.equal(need({}), false);
  assert.equal(need({render: 'always'}), true);
  assert.equal(need({wait_for: {selector: '#price'}}), true);
  assert.equal(need({formats: ['screenshot']}), true);
  assert.equal(need({route: {class: 'residential', country: 'US', render: true}}), true);
  assert.equal(parseFetchRequest({url: 'https://example.com/', wait_for: {selector: '#p'}}).request.wait_for.ms, 10000);
});

test('only public http(s) URLs are allowed', () => {
  for (const url of ['https://example.com/', 'http://example.com:8080/x', 'https://8.8.8.8/', 'https://[2606:4700::1111]/', 'https://a_b.example.com/']) {
    assert.ok(checkUrl(url), url);
  }
  for (const url of ['ftp://example.com/', 'https://user:pass@example.com/', 'https://localhost/', 'https://printer.local/',
    'https://10.0.0.1/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://example.com:22/', 'https://intranet/',
    'https://fetchx.ai/', 'https://api.fetchx.ai/', 'https://example.com/?k=fxk_' + 'a'.repeat(30), 'https://exa\\mple.com/',
    'https://example.com/ a', 'x'.repeat(12001)]) {
    assert.throws(() => checkUrl(url, {blocked: new Set(['fetchx.ai'])}), {code: 'url_not_allowed'}, url);
  }
  assert.equal(checkRedirect('/next', new URL('https://example.com/a')).href, 'https://example.com/next');
  assert.throws(() => checkRedirect('http://127.0.0.1/', new URL('https://example.com/')), {code: 'url_not_allowed'});
});

test('every DNS answer must be public', () => {
  assert.ok(checkAddresses([{address: '93.184.216.34', family: 4}]));
  for (const answers of [[], [{address: '10.1.2.3', family: 4}], [{address: '93.184.216.34', family: 4}, {address: '127.0.0.1', family: 4}],
    [{address: '168.63.129.16', family: 4}], [{address: '3fff::1', family: 6}], [{address: 'fd00::1', family: 6}]]) {
    assert.throws(() => checkAddresses(answers), {code: 'url_not_allowed'}, JSON.stringify(answers));
  }
  assert.equal(isPublicAddress({address: '2606:4700::1111', family: 6}), true);
  assert.equal(isPublicAddress({address: '93.184.216.34', family: 6}), false);
});
