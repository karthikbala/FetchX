// Webhook URLs are checked again at delivery with the same destination policy
// the engine uses for sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import {blockedHosts, checkUrl, checkRedirect, checkAddresses, FIXTURE_HOSTS, isPublicAddress} from '../src/fetch/destination.mjs';

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

test('of fetchx.ai, only the public test site may be fetched, unless the operator blocks it too', () => {
  const blocked = blockedHosts({});
  for (const host of FIXTURE_HOSTS) assert.equal(checkUrl(`https://${host}/login`, {blocked}).hostname, host);
  for (const url of ['https://fetchx.ai/', 'https://app.fetchx.ai/v1/me', 'https://x.fixtures.fetchx.ai/', 'https://notfixtures.fetchx.ai/']) {
    assert.throws(() => checkUrl(url, {blocked}), {code: 'url_not_allowed'}, url);
  }
  const operator = blockedHosts({destinations: {blockedHosts: ['fixtures.fetchx.ai']}});
  for (const host of FIXTURE_HOSTS) assert.throws(() => checkUrl(`https://${host}/`, {blocked: operator}), {code: 'url_not_allowed'}, host);
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
