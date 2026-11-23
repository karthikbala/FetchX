// POST /v1/feedback and GET /v1/feedback/{id} (src/fetch/feedback.mjs): a
// caller's report about how FetchX handled a page, with a copy of what FetchX
// did when it names a request; one open report per request and kind; a daily
// cap; staff review it (list and review are what the admin routes call).
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {FEEDBACK_PER_DAY} from '../src/fetch/feedback.mjs';
import {databaseUrl, openStore, platformFor, PROJECT, UNMETERED_TOKEN} from './helpers.mjs';

test('a caller reports a request FetchX could not get; staff see what FetchX did and reply', {skip: !databaseUrl}, async t => {
  const store = await openStore();
  t.after(() => store.close());
  const {call, platform} = await platformFor(store, {script: request => request.url.includes('/wall') ? {status: 'failed', error_code: 'blocked',
    challenge: {vendor: 'datadome', walls: 2, passed: false, passed_by: null}} : {body: '<html><body>ok</body></html>'}});
  const failed = (await call('POST', '/v1/fetch', {body: {url: 'https://Shop.Example.com/wall?q=1', render: 'always'}})).body;
  assert.equal(failed.status, 'failed');
  const evidence = {status_code: 200, final_url: 'https://shop.example.com/wall?q=1', content_type: 'text/html', body_excerpt: '<h1>Lamps</h1>',
    client: 'curl 8.5 from a home connection in DE'};
  let response = await call('POST', '/v1/feedback', {body: {fetch_id: failed.id, kind: 'blocked_via_fetchx_ok_from_home', message: 'Loads at home.', evidence}});
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const report = response.body;
  assert.deepEqual({...report, id: undefined, created_at: undefined, updated_at: undefined}, {id: undefined, kind: 'blocked_via_fetchx_ok_from_home',
    fetch_id: failed.id, url: 'https://shop.example.com/wall?q=1', method: null, message: 'Loads at home.', evidence, status: 'received', reply: null,
    created_at: undefined, updated_at: undefined});
  assert.equal(report.created_at, report.updated_at);
  assert.equal((await call('GET', `/v1/feedback/${report.id}`)).body.status, 'received');

  // The same report again returns the open one; another kind is a new report.
  response = await call('POST', '/v1/feedback', {body: {fetch_id: failed.id, kind: 'blocked_via_fetchx_ok_from_home'}});
  assert.deepEqual([response.status, response.body.id, response.body.message], [200, report.id, 'Loads at home.']);
  response = await call('POST', '/v1/feedback', {body: {fetch_id: failed.id, kind: 'wrong_content'}});
  assert.equal(response.status, 201);
  assert.notEqual(response.body.id, report.id);

  // A report by URL, without a request.
  response = await call('POST', '/v1/feedback', {body: {url: 'https://other.example.com/a', method: 'POST', kind: 'other', message: 'Times out.'}});
  assert.equal(response.status, 201);
  assert.deepEqual([response.body.fetch_id, response.body.method, response.body.evidence], [null, 'POST', {}]);
  assert.equal((await call('POST', '/v1/feedback', {body: {url: 'https://other.example.com/a', method: 'POST', kind: 'other'}})).status, 200);
  assert.equal((await call('POST', '/v1/feedback', {body: {url: 'https://other.example.com/a', kind: 'other'}})).status, 201, 'GET is another request');

  // Refusals: shape, another project's request or report, scopes.
  const refused = async (body, field) => {
    const answer = await call('POST', '/v1/feedback', {body});
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.deepEqual([answer.body.error.code, answer.body.error.details.field], ['invalid_request', field]);
  };
  await refused({kind: 'other'}, 'fetch_id');
  await refused({url: 'https://a.example.com/', kind: 'slow'}, 'kind');
  await refused({fetch_id: failed.id, url: 'https://a.example.com/', kind: 'other'}, 'url');
  await refused({fetch_id: 'nope', kind: 'other'}, 'fetch_id');
  await refused({url: 'ftp://a.example.com/', kind: 'other'}, 'url');
  await refused({url: 'https://a.example.com/', method: 'TRACE', kind: 'other'}, 'method');
  await refused({url: 'https://a.example.com/', kind: 'other', message: 'x'.repeat(2001)}, 'message');
  await refused({url: 'https://a.example.com/', kind: 'other', evidence: {status_code: 700}}, 'evidence.status_code');
  await refused({url: 'https://a.example.com/', kind: 'other', evidence: {cookies: 'a=b'}}, 'evidence.cookies');
  await refused({url: 'https://a.example.com/', kind: 'other', evidence: {body_excerpt: 'x'.repeat(4001)}}, 'evidence.body_excerpt');
  await refused({url: 'https://a.example.com/', kind: 'other', extra: true}, 'extra');
  assert.equal((await call('POST', '/v1/feedback', {body: {fetch_id: randomUUID(), kind: 'other'}})).status, 404);
  assert.equal((await call('POST', '/v1/feedback', {token: UNMETERED_TOKEN, body: {fetch_id: failed.id, kind: 'other'}})).status, 404,
    "another project's request");
  assert.equal((await call('GET', `/v1/feedback/${report.id}`, {token: UNMETERED_TOKEN})).status, 404, "another project's report");
  assert.equal((await call('GET', `/v1/feedback/${randomUUID()}`)).status, 404);
  assert.equal((await call('POST', '/v1/feedback', {token: 'wrong', body: {url: 'https://a.example.com/', kind: 'other'}})).status, 401);

  // Staff: open reports first, with what FetchX did; a review sets the status and the reply the caller sees.
  const list = await platform.feedback.list();
  assert.equal(list.length, 4);
  const seen = list.find(row => row.id === report.id);
  assert.deepEqual([seen.project, seen.host, seen.key_id, seen.reviewed_by], [PROJECT, 'shop.example.com', null, null]);
  assert.deepEqual({...seen.fetch, created_at: undefined, finished_at: undefined}, {status: 'failed', page_status: 'challenge', error_code: 'blocked',
    challenge: 'datadome', created_at: undefined, finished_at: undefined,
    attempts: [{transport: 'browser', class: 'direct', country: null, result: 'blocked', code: null, challenge: null, status_code: 403}]});
  const reviewed = await platform.feedback.review(report.id, {status: 'resolved', reply: '  Fixed: residential IPs in DE for this site. '}, 'ops@example.com');
  assert.deepEqual([reviewed.status, reviewed.reply, reviewed.reviewed_by], ['resolved', 'Fixed: residential IPs in DE for this site.', 'ops@example.com']);
  const after = (await call('GET', `/v1/feedback/${report.id}`)).body;
  assert.deepEqual([after.status, after.reply, 'reviewed_by' in after, 'fetch' in after], ['resolved', 'Fixed: residential IPs in DE for this site.', false, false]);
  assert.ok(after.updated_at >= after.created_at);
  assert.equal((await platform.feedback.list()).at(-1).id, report.id, 'a resolved report sorts after the open ones');
  assert.equal((await platform.feedback.review(report.id, {reply: null}, 'ops@example.com')).reply, null);
  assert.equal((await platform.feedback.review(report.id, {status: 'reviewing'}, 'ops@example.com')).status, 'reviewing');
  for (const [input, code] of [[{}, 'feedback_review_required'], [{status: 'done'}, 'feedback_status_invalid'], [{reply: 'x'.repeat(2001)}, 'feedback_reply_invalid']]) {
    await assert.rejects(platform.feedback.review(report.id, input, 'ops@example.com'), {code});
  }
  await assert.rejects(platform.feedback.review(randomUUID(), {status: 'resolved'}, 'ops@example.com'), {code: 'feedback_not_found'});
  // Once resolved, the same report makes a new one.
  await platform.feedback.review(report.id, {status: 'resolved'}, 'ops@example.com');
  assert.equal((await call('POST', '/v1/feedback', {body: {fetch_id: failed.id, kind: 'blocked_via_fetchx_ok_from_home'}})).status, 201);

  // A daily cap per project, then retention.
  await store.pool.query(`INSERT INTO fetch_feedback (id, project, kind, url, method, host) SELECT gen_random_uuid(), $1, 'other',
    'https://filler.example.com/' || n, 'GET', 'filler.example.com' FROM generate_series(1, $2) n`, [PROJECT, FEEDBACK_PER_DAY]);
  response = await call('POST', '/v1/feedback', {body: {url: 'https://a.example.com/', kind: 'other'}});
  assert.equal(response.status, 429);
  assert.equal(response.body.error.code, 'too_many_requests');
  assert.ok(response.body.error.retry_after_seconds > 0 && response.body.error.retry_after_seconds <= 86_400);
  assert.equal(response.headers['retry-after'], String(response.body.error.retry_after_seconds));
  await store.pool.query("UPDATE fetch_feedback SET created_at = now() - interval '91 days' WHERE host = 'filler.example.com'");
  await platform.feedback.prune();
  assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM fetch_feedback WHERE host = 'filler.example.com'")).rows[0].n, 0);
  assert.equal((await call('POST', '/v1/feedback', {body: {url: 'https://a.example.com/', kind: 'other'}})).status, 201);
});
