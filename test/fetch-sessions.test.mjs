import test from 'node:test';
import assert from 'node:assert/strict';
import {StickySessions, sessionSettings, SESSION_DEFAULTS} from '../src/fetch/sessions.mjs';
import {ExitGeo, parseExitGeo, validTimezone, exitGeoSettings} from '../src/fetch/exit-geo.mjs';
import {browserPlace} from '../src/fetch/browser-attempt.mjs';
import {checkCaptureInput} from '../src/browser/capture-input.mjs';

const where = {host: 'shop.example.com', provider: 'dataimpulse', country: 'US'};

test('a session that passed is kept for its host, leased to one step at a time, and rotated', () => {
  let now = 1_000_000;
  const sessions = new StickySessions({browser: {sessions: {rotateAfter: 3, maxAgeMs: 60_000}}}, {now: () => now});
  assert.equal(sessions.lease(where), null, 'nothing kept yet: the step draws a fresh session');
  sessions.settle(where, {session: 'aaaaaaaaaa', ip: '203.0.113.7', identity: {navigator: {}}}, 'passed');
  sessions.settle({...where, host: 'other.example.com'}, {session: 'bbbbbbbbbb'}, 'passed');
  const lease = sessions.lease(where);
  assert.deepEqual({session: lease.session, ip: lease.ip, pages: lease.pages}, {session: 'aaaaaaaaaa', ip: '203.0.113.7', pages: 1});
  assert.deepEqual(lease.identity, {navigator: {}}, 'the device identity stays with the session');
  assert.equal(sessions.lease(where), null, 'a leased session is never shared by two browsers');
  sessions.settle(where, lease, 'neutral');
  assert.equal(sessions.lease(where).session, 'aaaaaaaaaa', 'nothing reached the site: the session is just freed');
  sessions.settle(where, {session: 'aaaaaaaaaa', ip: '203.0.113.7'}, 'passed');
  sessions.lease(where);
  sessions.settle(where, {session: 'aaaaaaaaaa', ip: '203.0.113.7'}, 'passed');
  assert.equal(sessions.lease(where), null, 'retired after rotateAfter pages');
  // A different provider or country is a different pool.
  assert.equal(sessions.lease({...where, provider: 'evomi'}), null);
  assert.equal(sessions.lease({...where, host: 'other.example.com'}).session, 'bbbbbbbbbb');
  // Age limit.
  sessions.settle(where, {session: 'cccccccccc'}, 'passed');
  now += 61_000;
  assert.equal(sessions.lease(where), null, 'retired after maxAgeMs');
});

test('a wall, a rate limit or a moved IP drops the session', () => {
  const sessions = new StickySessions({});
  for (const outcome of ['burned', 'moved']) {
    sessions.settle(where, {session: 'aaaaaaaaaa', ip: '203.0.113.7'}, 'passed');
    const lease = sessions.lease(where);
    sessions.settle(where, lease, outcome);
    assert.equal(sessions.lease(where), null, outcome);
  }
  sessions.settle(where, {session: 'aaaaaaaaaa', ip: '203.0.113.7'}, 'passed');
  sessions.lease(where);
  sessions.settle(where, {session: 'aaaaaaaaaa', ip: '198.51.100.1'}, 'passed');
  assert.equal(sessions.lease(where), null, 'a pass from another exit IP does not vouch for the kept one');
  // Burning a session that was never kept is harmless.
  sessions.settle(where, {session: 'dddddddddd'}, 'burned');
  assert.equal(sessions.lease(where), null);
});

test('pacing spaces pages on one session and browser steps on a guarded host', async () => {
  let now = 0;
  const waits = [];
  const sessions = new StickySessions({browser: {sessions: {sessionGapMs: 4000, hostGapMs: 1000}}},
    {now: () => now, wait: async ms => { waits.push(ms); now += ms; }, random: () => 0});
  assert.equal(await sessions.pace({host: 'a.example', guarded: false}), 0, 'an unguarded host with a fresh session is not paced');
  assert.equal(await sessions.pace({host: 'a.example', guarded: true}), 0);
  assert.equal(await sessions.pace({host: 'a.example', guarded: true}), 1000, 'guarded host: steps are spaced');
  assert.equal(await sessions.pace({host: 'b.example', guarded: true}), 0, 'per host');
  const lease = {lastUsedAt: now};
  assert.equal(await sessions.pace({host: 'c.example', lease}), 4000, 'a kept session waits its pace');
  assert.equal(await sessions.pace({host: 'd.example', lease: {lastUsedAt: now}, deadline: now + 46_000}), 1000,
    'never so long that the step cannot finish');
  assert.deepEqual(waits, [1000, 4000, 1000]);
  assert.deepEqual(sessionSettings({browser: {sessions: {rotateAfter: -1, hostGapMs: 'x'}}}).rotateAfter, SESSION_DEFAULTS.rotateAfter);
});

test('the exit IP decides the browser timezone, position and locale', async () => {
  assert.equal(validTimezone('America/Los_Angeles'), true);
  assert.equal(validTimezone('America/Indiana/Indianapolis'), true);
  assert.equal(validTimezone('Not/AZone'), false);
  assert.equal(validTimezone('UTC'), false, 'a zone with no region is not a residential exit');
  assert.deepEqual(parseExitGeo({ip: '203.0.113.7', country: 'US', timezone: 'America/Los_Angeles', loc: '34.0522,-118.2437'}),
    {ip: '203.0.113.7', country: 'US', timezone: 'America/Los_Angeles', geolocation: {latitude: 34.0522, longitude: -118.2437}});
  assert.equal(parseExitGeo({ip: '203.0.113.7', timezone: 'Mars/Base'}), null);
  assert.deepEqual(parseExitGeo({ip: '203.0.113.7', timezone: 'Europe/Berlin', loc: 'nowhere'}).geolocation, null);
  assert.deepEqual(browserPlace({country: 'US'}, {country: 'US', timezone: 'America/Chicago', geolocation: {latitude: 41.9, longitude: -87.6}}),
    {locale: 'en-US', timezone: 'America/Chicago', geolocation: {latitude: 41.9, longitude: -87.6}});
  assert.deepEqual(browserPlace({country: 'DE'}, null), {locale: 'de-DE', timezone: 'Europe/Berlin', geolocation: null});
  assert.deepEqual(browserPlace({country: 'US'}, {country: 'GB', timezone: 'Europe/London', geolocation: null}),
    {locale: 'en-GB', timezone: 'Europe/London', geolocation: null}, 'the exit country wins over the route country');

  assert.equal(exitGeoSettings({browser: {exitGeo: false}}), null, 'can be turned off');
  assert.equal(exitGeoSettings({browser: {exitGeo: {endpoint: 'http://plain.example/json'}}}), null, 'https only');
  const seen = [];
  const exchangeImpl = async (request, destination, limits, {proxy}) => {
    seen.push({url: destination.url.href, address: destination.address, proxy: proxy.url, method: request.method});
    return {status: 200, headers: {'content-type': 'application/json'},
      encoded: Buffer.from(JSON.stringify({ip: '203.0.113.7', country: 'US', timezone: 'America/Denver', loc: '39.7,-105.0'}))};
  };
  const geo = new ExitGeo({}, {resolve: async () => [{address: '34.117.59.81', family: 4}], exchangeImpl});
  const proxy = {id: 'dataimpulse:aaaaaaaaaa', url: 'http://user:pass@gw.example:823/'};
  assert.equal((await geo.lookup(proxy)).timezone, 'America/Denver');
  assert.equal((await geo.lookup(proxy)).ip, '203.0.113.7');
  assert.deepEqual(seen, [{url: 'https://ipinfo.io/json', address: '34.117.59.81', proxy: proxy.url, method: 'GET'}],
    'looked up once per session, through the session\'s own proxy');
  const failing = new ExitGeo({}, {resolve: async () => [{address: '34.117.59.81', family: 4}], exchangeImpl: async () => { throw new Error('down'); }});
  assert.equal(await failing.lookup(proxy), null, 'a failed lookup never fails the step');
  const privateAnswer = new ExitGeo({}, {resolve: async () => [{address: '10.0.0.1', family: 4}], exchangeImpl});
  assert.equal(await privateAnswer.lookup(proxy), null, 'the lookup host must resolve to a public address');
  assert.equal(await geo.lookup(null), null);
});

test('capture input carries the place, a kept identity, warm-up and the self-clear budget', () => {
  const base = {url: 'https://shop.example.com/p', deadline: Date.now() + 30_000, runtime: {engine: 'camoufox'},
    limits: {max_requests: 500, max_dom_bytes: 1_000_000, max_body_bytes: 1_000_000}, screenshot: false, captcha: true};
  const input = checkCaptureInput({...base, timezone: 'America/Indiana/Indianapolis', geolocation: {latitude: 39.7, longitude: -86.1},
    fingerprint: {navigator: {userAgent: 'Mozilla/5.0 Firefox/158.0'}}, warmup: true, self_clear_ms: 45_000});
  assert.equal(input.warmup, true);
  assert.equal(input.self_clear_ms, 45_000);
  assert.deepEqual(input.geolocation, {latitude: 39.7, longitude: -86.1});
  const drawnSize = {navigator: {userAgent: 'Mozilla/5.0'}, fonts: Array.from({length: 14000}, (_, i) => `Font Family ${i} Regular`)};
  assert.ok(Buffer.byteLength(JSON.stringify(drawnSize)) > 300_000, 'about the size Camoufox draws');
  assert.deepEqual(checkCaptureInput({...base, fingerprint: drawnSize}).fingerprint, drawnSize, 'a real-size identity is accepted');
  const plain = checkCaptureInput(base);
  assert.deepEqual([plain.warmup, plain.self_clear_ms, plain.geolocation, plain.fingerprint], [false, 0, null, null]);
  for (const bad of [{geolocation: {latitude: 91, longitude: 0}}, {geolocation: 'here'}, {self_clear_ms: 120_000},
    {warmup: 'yes'}, {fingerprint: ['x']}, {fingerprint: {blob: 'x'.repeat(1_100_000)}}, {timezone: '../etc'}]) {
    assert.throws(() => checkCaptureInput({...base, ...bad}), /invalid capture input/, JSON.stringify(bad).slice(0, 60));
  }
});
