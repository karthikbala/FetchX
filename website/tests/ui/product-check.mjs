// UI contract smoke tests use synthetic control API responses. The separate local
// integration harness verifies the journey against the real gateway and database.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4328';
const out = process.env.TEST_OUTPUT_DIR || '.local/browser-reports';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.TEST_CHROME_CHANNEL ? { channel: process.env.TEST_CHROME_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [], external = [], checks = [], accessibility = [], calls = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.push(request.url()); });
let signedIn = false, enabled = true, responseState = 'completed', recoveryMissing = false;
let logoutFailure = false, logoutPause = null, fetchPause = null;
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'private-fixture@example.test' };
const projectId = 'cp_22222222-2222-4222-8222-222222222222';
const projects = [], keys = [], operations = [], envelopes = new Map();
let keyNumber = 0, fetchPosts = 0, recoveries = 0;
const token = () => 'fxk_SYNTHETIC_UI_FIXTURE_' + keyNumber;
const credits = () => ({ granted: 20, available: 20 - fetchPosts, settled: responseState === 'completed' ? fetchPosts : Math.max(0, fetchPosts - 1), held: responseState === 'unknown' ? 1 : 0, reserved: 0, released: 0, commercial_enabled: false });
const session = () => ({ user, csrf_token: 'synthetic-csrf-ui-fixture', projects });
const safeProject = name => ({ id: projects.length ? 'cp_33333333-3333-4333-8333-333333333333' : projectId, name, status: 'active', created_at: '2026-11-02T10:00:00Z' });
let managedProjectId = '', managedKeys = [], renderPosts = 0, renderRecoveries = 0, prepareCalls = 0;
let nextRenderState = 'completed', targetPriced = false, preparePause = null;
const managedEnvelopes = new Map();
const testJpeg = await (async () => {
  const fixture = await context.newPage(); await fixture.setViewportSize({ width: 8, height: 8 });
  try { return (await fixture.screenshot({ type: 'jpeg' })).toString('base64'); } finally { await fixture.close(); }
})();
const managedMatrix = {
  executions: [
    { id: 'http', available: true, reason: null, methods: ['GET', 'HEAD'], headers: ['accept', 'accept-language', 'user-agent'] },
    { id: 'browser', available: true, reason: null, methods: ['GET'], headers: [], max_wait_ms: 750 },
  ],
  routes: [
    { class: 'direct', available: true, countries: [] },
    { class: 'datacenter', available: true, countries: ['US', 'GB'], executions: {
      http: { available: true, countries: ['US', 'GB'] }, browser: { available: true, countries: ['US'] },
    } },
    { class: 'residential', available: false, reason: 'residential_provider_held', countries: [] },
  ],
};
const provisionalMatrix = {
  executions: managedMatrix.executions.map(item => ({ ...item, available: false, reason: 'playground_target_required' })),
  routes: managedMatrix.routes.map(item => ({
    class: item.class, available: false, countries: [], reason: item.class === 'datacenter' ? 'playground_target_required' : 'playground_route_unreviewed',
  })),
};
const targetMatrix = { ...managedMatrix, routes: managedMatrix.routes.map(item => item.class === 'direct' ? { ...item, available: false, reason: 'playground_route_unreviewed' } : item) };
function selectedManagedKey(body) {
  const eligible = managedKeys.filter(item => !item.revoked_at && item.scopes.includes('fetch:write'));
  return {
    eligible,
    key: body.key_id ? eligible.find(item => item.id === body.key_id) : eligible.length === 1 ? eligible[0] : null,
  };
}
const managedKey = (digit, name, scopes = ['fetch:write', 'fetch:read'], revoked_at = null) => ({
  id: digit.repeat(8) + '-7777-4777-8777-' + digit.repeat(12), name, scopes, revoked_at,
});
const profile = { id: 'fixture-http', version: 1, origins: ['https://approved.example'], paths: ['/'], methods: ['GET', 'HEAD'], proxy_classes: ['direct'], countries: [], route_reservations: [{ class: 'direct', country: null, estimated_micro_usd: 0 }] };
await context.route('**/api/control/**', async route => {
  const request = route.request(), method = request.method(), path = new URL(request.url()).pathname.replace('/api/control', '');
  const body = request.postDataJSON(); calls.push({ method, path, body });
  const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  const fail = (code, message, status = 400) => send({ error: { code, message } }, status);
  if (path === '/status') return send({ enabled, mail_configured: enabled, api_base_url: 'https://api.fixture.example', capabilities: { native_http: true } }, enabled ? 200 : 503);
  if (path === '/auth/code') return send({ challenge_id: 'synthetic-challenge', expires_in: 600, accepted: true });
  if (path === '/auth/verify') {
    if (body.code !== '12345678') return fail('code_invalid', 'The verification code is invalid or expired.');
    signedIn = true; return send(session());
  }
  if (path === '/session') return signedIn ? send(session()) : fail('unauthorized', 'Verify your email to continue.', 401);
  if (!signedIn) return fail('unauthorized', 'A verified session is required.', 401);
  if (method !== 'GET') assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf-ui-fixture', 'Authenticated mutations need CSRF');
  if (path === '/auth/logout') { if (logoutPause) await logoutPause; if (logoutFailure) return fail('logout_unavailable', 'Sign out is temporarily unavailable. Try again.', 503); signedIn = false; return send({ logged_out: true }); }
  if (path === '/projects' && method === 'POST') { const project = safeProject(body.name); projects.push(project); return send({ project }, 201); }
  if (path === '/projects') return send({ projects });
  const match = /^\/projects\/([^/]+)(.*)$/.exec(path);
  if (!match) return fail('route_not_found', 'Unknown route.', 404);
  const project = projects.find(item => item.id === match[1]), resource = match[2];
  if (!project) return fail('project_forbidden', 'Project not found.', 404);
  if (project.id === managedProjectId) {
    if (!resource) return send({ project, capabilities: { playground: targetPriced ? provisionalMatrix : managedMatrix }, access_profiles: [profile] });
    if (resource === '/keys' && method === 'GET') return send({ keys: managedKeys });
    if (resource === '/playground/prepare' && method === 'POST') {
      prepareCalls++;
      const { eligible, key } = selectedManagedKey(body);
      const invalidDestination = new URL(body.url).hostname === '127.0.0.1';
      const invalidRoute = targetPriced && body.proxy.class === 'direct';
      const errors = [
        ...(invalidDestination ? [{ field: 'url', code: 'destination_rejected', message: 'Use a public website. Private destinations are unavailable.' }] : []),
        ...(invalidRoute ? [{ field: 'proxy', code: 'playground_route_unreviewed', message: 'Direct is unavailable.' }] : []),
        ...(!key ? [{ field: 'key_id', code: 'playground_key_selection_required', message: eligible.length ? 'Choose a project API key.' : 'Create a project API key.' }] : []),
      ];
      if (preparePause && body.url.includes('defer-this-quote')) await preparePause;
      return send({
        ready: !errors.length, execution: body.execution, url: new URL(body.url).href,
        access_profile: invalidDestination ? null : { id: 'playground:fixture-' + body.execution, version: 1 },
        selected_key_id: key?.id || null, keys: eligible, capabilities: targetPriced ? targetMatrix : managedMatrix,
        quote: !errors.length ? { credits: body.execution === 'browser' ? 3 : 1, max_estimated_micro_usd: 1300 } : null,
        errors,
      });
    }
    if ((resource === '/render' || resource === '/fetch') && method === 'POST') {
      const { key } = selectedManagedKey(body);
      if (!key) return send({
        state: 'rejected', success: false, operation_id: null,
        error: { code: 'playground_key_selection_required', message: 'Choose a project API key.' },
      }, 409);
      renderPosts++;
      const browserMode = resource === '/render';
      assert.equal(body.access_profile.id, 'playground:fixture-' + (browserMode ? 'browser' : 'http'));
      assert.equal(body.max_estimated_micro_usd, 1300);
      const stored = await page.evaluate(() => Object.entries(sessionStorage));
      assert.ok(stored.some(([name, value]) => name === 'fetchx-pending-operations:' + managedProjectId && value.includes(body.idempotency_key)));
      const result = {
        success: nextRenderState === 'completed', state: nextRenderState, execution: browserMode ? 'browser' : 'http',
        operation_id: '55555555-4444-4444-8444-' + String(renderPosts).padStart(12, '0'), idempotency_key: body.idempotency_key,
        gateway_http_status: 200, routing: { ...body.proxy, provider: 'fixture' },
        data: { status: nextRenderState === 'unknown' ? null : 200, text: '<main>Managed source fixture</main>', headers: { 'content-type': 'text/html' } },
        usage: { duration_ms: 145, decoded_bytes: 34, ...(browserMode ? { capture_complete: false, blocked_requests: 2 } : {}), accounting: { request_credits: { credits: browserMode ? 3 : 1, state: nextRenderState === 'unknown' ? 'held' : 'settled', key_id: key.id } } },
        artifacts: body.screenshot ? [{ kind: 'browser_screenshot', content_type: 'image/jpeg', body_base64: testJpeg, url: 'https://leak.invalid/do-not-fetch' }] : [],
        error: nextRenderState === 'unknown' ? { code: 'source_timeout_unknown', message: 'The browser outcome is uncertain.' } : null,
      };
      managedEnvelopes.set(body.idempotency_key, result); return send(result);
    }
    if (resource.startsWith('/render/') && method === 'GET') {
      renderRecoveries++;
      const result = managedEnvelopes.get(decodeURIComponent(resource.slice(8)));
      return result ? send(result) : fail('operation_not_found', 'No retained render was found.', 404);
    }
  }
  if (!resource) return send({ project, capabilities: { native_http: true, routes: ['direct'], render: false }, access_profiles: [profile] });
  if (resource === '/keys' && method === 'GET') return send({ keys });
  if (resource === '/keys' && method === 'POST') { keyNumber++; const key = { id: 'key-' + keyNumber, name: body.name, scopes: body.scopes, created_at: '2026-11-02T10:00:00Z', revoked_at: null }; keys.push(key); return send({ key, token: token() }, 201); }
  if (/^\/keys\/[^/]+\/rotate$/.test(resource)) { const old = keys.find(key => resource.includes('/' + key.id + '/')); old.revoked_at = '2026-11-02T11:00:00Z'; keyNumber++; const key = { ...old, id: 'key-' + keyNumber, revoked_at: null }; keys.push(key); return send({ key, token: token() }); }
  if (resource.startsWith('/keys/') && method === 'DELETE') { keys.find(key => resource.endsWith('/' + key.id)).revoked_at = '2026-11-02T11:00:00Z'; return send({ revoked: true }); }
  if (resource === '/usage') return send({ gateway: { outcomes: { source_successes: operations.filter(item => item.state === 'completed').length, source_failures: 0, gateway_failures: 0, unknown: operations.filter(item => item.state === 'unknown').length }, by_key_and_state: operations.map(item => ({ operations: 1, state: item.state })), latency_ms: { mean: operations.length ? 84 : null, p95: operations.length ? 96 : null, completed_operations: operations.length } }, credits: credits() });
  if (resource === '/billing') return send({ status: 'trial', credits: credits(), commercial_enabled: false });
  if (resource === '/requests') return send({ operations, limit: 100, scope: 'v2_project' });
  if (resource.startsWith('/requests/')) return send([...envelopes.values()].find(item => resource.endsWith('/' + item.operation_id)));
  if (resource === '/fetch' && method === 'POST') {
    fetchPosts++;
    assert.equal(body.access_profile.id, profile.id); assert.deepEqual(body.proxy, { class: 'direct', country: null });
    const stored = await page.evaluate(() => Object.entries(sessionStorage));
    assert.ok(stored.some(([name, value]) => name.startsWith('fetchx-pending-operations:') && value.includes(body.idempotency_key)), 'Operation key must be stored before dispatch');
    const operation = { id: '44444444-4444-4444-8444-' + String(fetchPosts).padStart(12, '0'), state: responseState === 'network_error' ? 'unknown' : responseState, access_profile: { id: profile.id, version: 1 }, route: { class: 'direct', country: null }, latency_ms: 84, created_at: '2026-11-02T11:00:00Z' };
    operations.unshift(operation);
    const result = { success: responseState === 'completed', state: responseState === 'network_error' ? 'unknown' : responseState, operation_id: operation.id, idempotency_key: body.idempotency_key, routing: operation.route, diagnostics: { notes: Array(100).fill('Synthetic diagnostic line.') }, data: { status: responseState === 'completed' ? 200 : null, text: '<img src="https://leak.invalid/private"> source text fixture' + '\nRetained synthetic response line.'.repeat(100), content_type: 'text/html' }, error: responseState === 'unknown' ? { code: 'source_timeout_unknown', message: 'The source outcome is unknown. Recover this key.' } : null, retry: { lookup_url: '/api/control/projects/' + project.id + '/fetch/' + body.idempotency_key }, application_acceptance: 'not_evaluated' };
    if (responseState === 'unknown') result.data.text += '\n'.repeat(50_000);
    if (fetchPause) await fetchPause;
    envelopes.set(body.idempotency_key, result); if (responseState === 'network_error') return route.abort('failed'); return send(result);
  }
  if (resource.startsWith('/fetch/') && method === 'GET') { recoveries++; if (recoveryMissing) return send({ success: false, state: 'rejected', operation_id: null, error: { code: 'operation_not_found', message: 'No retained operation was found yet.' } }, 404); const result = envelopes.get(decodeURIComponent(resource.slice(7))); return result ? send(result) : fail('operation_not_found', 'No retained operation was found.', 404); }
  return fail('route_not_found', 'Unknown route.', 404);
});
const audit = async name => { const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); accessibility.push({ name, violations: result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ html: node.html, summary: node.failureSummary })) })) }); };
const storage = () => page.evaluate(() => JSON.stringify({ session: Object.entries(sessionStorage), local: Object.entries(localStorage) }));

try {
  await page.goto(base + '/signup');
  await expect(page.locator('[data-signup-email] button')).toBeEnabled();
  await page.locator('[data-signup-email] input').fill(user.email); await page.locator('[data-signup-email] button').click();
  await expect(page.locator('[data-signup-stage="1"]')).toBeVisible();
  await page.locator('[data-signup-verify] input').fill('00000000'); await page.locator('[data-signup-verify] button').click();
  await expect(page.locator('[data-page-error]')).toContainText('invalid or expired'); assert.equal(projects.length, 0);
  await page.locator('[data-signup-verify] input').fill('12345678'); await page.locator('[data-signup-verify] button').click();
  await expect(page.locator('[data-signup-stage="2"]')).toBeVisible(); assert.equal(projects.length, 0, 'Email verification must not create a project');
  await page.locator('[data-signup-project] input').fill('Private project fixture'); await page.locator('[data-signup-project] button').click();
  await expect(page.locator('[data-signup-stage="3"]')).toBeVisible(); assert.equal(keys.length, 0, 'Project creation must not create a key');
  const signupName = page.locator('[data-signup-key] input[name="name"]');
  await expect(signupName).toHaveValue(''); await signupName.focus();
  assert.equal(await signupName.evaluate(node => getComputedStyle(node, '::placeholder').opacity), '0');
  await signupName.fill('My fixture key'); await signupName.blur(); await signupName.focus(); await expect(signupName).toHaveValue('My fixture key');
  await page.locator('[data-signup-key] input[value="usage:read"]').uncheck(); await page.locator('[data-signup-key] button').click();
  await expect(page.locator('[data-signup-secret]')).toContainText(token()); assert.ok(!keys[0].scopes.includes('usage:read'));
  await page.locator('[data-signup-copy]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token());
  await audit('verified signup key reveal');
  await page.locator('[data-finish-signup]').click(); await expect(page.locator('[data-request-url]')).toBeVisible(); await expect(page.locator('[data-run-request]')).toBeDisabled();
  await expect(page.locator('input[value="browser"]')).toBeDisabled(); await expect(page.locator('[data-request-country]')).toBeDisabled();
  await expect(page.locator('[data-request-profile-field]')).toBeHidden();
  await expect(page.locator('[data-request-route] option[value="direct"]')).not.toHaveAttribute('disabled');
  await expect(page.locator('[data-request-route] option[value="datacenter"]')).toHaveAttribute('disabled', '');
  await page.locator('[data-request-url]').fill('https://approved.example/private-path'); await page.locator('[data-run-request]').click();
  await expect(page.locator('[data-response-state]')).toHaveText('Completed');
  await expect(page.locator('[data-response-output]')).toContainText('<img src='); assert.equal(await page.locator('.pp-response-panel img[src]').count(), 0);
  assert.equal(fetchPosts, 1); await expect(page.locator('[data-run-request]')).toBeDisabled();
  await page.locator('[data-inspector-tab="code"]').click();
  await expect(page.locator('[data-generated-code]')).toContainText('uuidgen');
  await page.locator('[data-code-operation]').selectOption('recover');
  await expect(page.locator('[data-generated-code]')).toContainText('/v2/fetch/console_');
  for (const language of ['curl', 'javascript', 'python']) { await page.locator('[data-code-language]').selectOption(language); await page.locator('[data-copy-code]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.locator('[data-generated-code]').textContent()); }
  await page.locator('[data-inspector-tab="output"]').focus(); await page.keyboard.press('ArrowRight'); await expect(page.locator('[data-inspector-tab="headers"]')).toBeFocused();
  const populatedPosts = fetchPosts;
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [tab, selector, label] of [
      ['output', '[data-response-output]', 'Response text'],
      ['diagnostics', '[data-response-diagnostics]', 'Response diagnostics'],
      ['code', '[data-generated-code]', 'Generated request code'],
    ]) {
      await page.locator(`[data-inspector-tab="${tab}"]`).click();
      const region = page.locator(selector);
      await expect(region).toBeVisible(); await expect(region).toHaveAttribute('tabindex', '0'); await expect(region).toHaveAccessibleName(label);
      await region.focus(); await expect(region).toBeFocused();
      await audit(`populated success ${tab} at ${width}`);
    }
  }
  assert.equal(fetchPosts, populatedPosts, 'Inspecting populated panels must not dispatch source work');
  await page.setViewportSize({ width: 1440, height: 1000 });
  checks.push('Verified email, explicit project and scoped key creation, reveal once, approved routes, first fetch, escaped source text and code/keyboard tabs');

  responseState = 'unknown'; await page.locator('[data-new-request]').click(); await page.locator('[data-run-request]').click();
  await expect(page.locator('[data-response-state]')).toHaveText('Unknown'); const postsBefore = fetchPosts;
  const unknownPreview = JSON.parse(await page.locator('[data-response-diagnostics]').textContent());
  assert.equal(unknownPreview.error.code, 'source_timeout_unknown');
  assert.equal(unknownPreview.source.content_type, 'text/html');
  assert.match(await page.locator('[data-response-output]').textContent(), /Source text truncated/);
  await expect(page.locator('[data-response-error]')).toContainText('source outcome is unknown');
  await page.reload(); await expect(page.locator('[data-response-state]')).toHaveText('Pending recovery'); assert.equal(fetchPosts, postsBefore);
  recoveryMissing = true; await page.locator('[data-recover-result]').click(); await expect(page.locator('[data-response-state]')).toHaveText('Rejected'); assert.ok((await storage()).includes('console_'), 'A not-found lookup must retain the pending key'); recoveryMissing = false;
  await page.locator('[data-recover-result]').click(); await expect(page.locator('[data-response-state]')).toHaveText('Unknown'); assert.equal(fetchPosts, postsBefore); assert.equal(recoveries, 2);
  assert.ok((await storage()).includes('console_'));
  await page.locator('[data-new-request]').click(); await expect(page.locator('[data-confirm-dialog]')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click(); await expect(page.locator('[data-run-request]')).toBeDisabled();
  await page.locator('[data-new-request]').click(); await page.locator('[data-confirm-action]').click(); await expect(page.locator('[data-run-request]')).toBeDisabled();
  await page.locator('[data-request-url]').fill('https://approved.example/draft-only'); await expect(page.locator('[data-run-request]')).toBeEnabled(); assert.equal(fetchPosts, postsBefore);
  await expect(page.locator('[data-pending-operation]')).toBeVisible();
  await expect(page.locator('[data-pending-operation] option')).toHaveCount(1);
  await expect(page.locator('[data-recover-result]')).toBeEnabled();
  checks.push('Unknown outcome survives reload, GET recovery only, no automatic retry, explicit new request confirmation and retained operation key');

  await page.goto(base + '/app/requests'); await expect(page.locator('[data-request-id]')).toHaveCount(2); await page.locator('[data-request-id]').first().click(); await expect(page.locator('[data-request-dialog]')).toBeVisible(); await expect(page.locator('[data-request-detail]')).toContainText('source_timeout_unknown'); await expect(page.locator('[data-request-detail]')).toHaveAttribute('tabindex', '0'); await expect(page.locator('[data-request-detail]')).toHaveAccessibleName('Retained response text'); await audit('retained request details'); await page.keyboard.press('Escape');
  await page.locator('[data-request-filter]').selectOption('completed'); await expect(page.locator('[data-request-id]')).toHaveCount(1); await page.locator('[data-request-search]').fill('no-match'); await expect(page.locator('[data-request-id]')).toHaveCount(0);
  await page.goto(base + '/app/keys'); await expect(page.locator('[data-key-secret]')).toHaveText('Concealed'); const keyName = page.locator('[data-create-key] input[name="name"]'); await expect(keyName).toHaveValue(''); await page.locator('h1').click(); assert.equal(await keyName.evaluate(node => getComputedStyle(node, '::placeholder').opacity), '1'); await keyName.focus(); assert.equal(await keyName.evaluate(node => getComputedStyle(node, '::placeholder').opacity), '0'); await keyName.fill('Fixture server key'); await keyName.blur(); await keyName.focus(); await expect(keyName).toHaveValue('Fixture server key'); await page.locator('[data-create-key] button[type="submit"]').click(); await expect(page.locator('[data-key-dialog]')).toBeVisible(); await audit('key reveal');
  // Observe the DOM at close() entry: waiting for the queued close event would
  // allow a hidden dialog to retain its secret and miss the regression.
  await page.evaluate(() => {
    const dialog = document.querySelector('[data-key-dialog]');
    const originalClose = dialog.close;
    dialog.close = function (...args) {
      this.dataset.secretAtClose = document.querySelector('[data-key-secret]').textContent;
      return originalClose.apply(this, args);
    };
  });
  await page.locator('[data-close-key]').click();
  assert.equal(await page.locator('[data-key-dialog]').getAttribute('data-secret-at-close'), 'Concealed', 'Explicit close must conceal synchronously before close()');
  await expect(page.locator('[data-key-dialog]')).not.toBeVisible(); await expect(page.locator('[data-key-secret]')).toHaveText('Concealed');
  await page.evaluate(() => { const dialog = document.querySelector('[data-key-dialog]'); delete dialog.close; delete dialog.dataset.secretAtClose; });
  await page.locator('[data-rotate-key="key-2"]').click(); await page.locator('[data-confirm-action]').click(); await expect(page.locator('[data-key-dialog]')).toBeVisible();
  await page.evaluate(() => document.querySelector('[data-key-dialog]').addEventListener('cancel', event => { event.currentTarget.dataset.secretAtCancel = document.querySelector('[data-key-secret]').textContent; }, { once: true }));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-key-dialog]').getAttribute('data-secret-at-cancel'), 'Concealed', 'Cancel must conceal synchronously');
  await expect(page.locator('[data-key-secret]')).toHaveText('Concealed'); await page.locator('[data-revoke-key="key-3"]').click(); await page.locator('[data-confirm-action]').click(); await expect(page.locator('[data-key-id="key-3"]')).toContainText('Revoked');
  checks.push('Live history filtering/detail lookup, scoped key creation, rotation and revocation with secrets concealed on close');

  await page.goto(base + '/app/billing'); await expect(page.locator('[data-billing-status]')).toHaveText('Trial access'); await expect(page.locator('[data-request-count]')).toHaveText('2'); await expect(page.locator('[data-mean-latency]')).toHaveText('84 ms'); await expect(page.locator('[data-reserved-credits]')).toHaveText('1'); assert.equal(await page.locator('[data-select-plan],[data-spend-form],[data-reset-demo]').count(), 0);
  await page.locator('[data-open-project]').first().click(); await page.locator('[data-create-project] input').fill('Second private project'); await page.locator('[data-create-project] button[type="submit"]').click(); await expect(page.locator('[data-project-select]')).toHaveValue(projects[1].id); await page.locator('[data-project-select]').selectOption(projectId); await expect(page.locator('[data-project-name]')).toHaveText('Private project fixture');
  for (const route of ['/signup', '/login', '/app', '/app/onboarding', '/app/playground', '/app/requests', '/app/keys', '/app/billing']) {
    const response = await page.goto(base + route); assert.equal(response.status(), 200); await expect(page.locator('h1')).toHaveCount(1); await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
    if (route.startsWith('/app')) await expect(page.locator('[data-workspace-content]')).toBeVisible();
    else { await expect(page.locator('[data-auth-account] [data-user-email]')).toHaveText(user.email); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(); }
    for (const width of [320, 360, 375, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route + ' overflows at ' + width); if (route.startsWith('/app')) { const signout = page.getByRole('button', { name: 'Sign out', exact: true }); await expect(page.locator('.pp-topbar [data-user-email]')).toHaveText(user.email); await expect(signout).toBeInViewport(); await expect(page.locator('[data-app-menu]')).toHaveAttribute('aria-expanded', 'false'); } }
    await audit(route); if (route === '/app') await page.screenshot({ path: out + '/live-workspace-overview.png', fullPage: true });
  }
  const originalProjectName = projects[0].name; projects[0].name = 'Long-project-name-'.repeat(10);
  await page.goto(base + '/app'); await expect(page.locator('[data-project-name]')).toHaveText(projects[0].name);
  for (const width of [320, 375, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 800 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Long project name overflows at ' + width); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeInViewport(); }
  projects[0].name = originalProjectName;
  await page.setViewportSize({ width: 390, height: 800 });
  const workspaceUrl = page.url();
  const openNavigation = page.getByRole('button', { name: 'Open workspace navigation', exact: true });
  const closeNavigation = page.getByRole('button', { name: 'Close workspace navigation', exact: true });
  const navigation = page.getByRole('complementary', { name: 'Workspace navigation', exact: true });
  await expect(navigation).toHaveCount(0);
  await openNavigation.click();
  await expect(openNavigation).toHaveAttribute('aria-expanded', 'true');
  await closeNavigation.click();
  await expect(page).toHaveURL(workspaceUrl);
  await expect(openNavigation).toBeFocused();
  await expect(navigation).toHaveCount(0);
  await openNavigation.click();
  await page.keyboard.press('Escape');
  await expect(openNavigation).toHaveAttribute('aria-expanded', 'false');
  await expect(openNavigation).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const persisted = await storage(); for (const secret of [user.email, 'Private project', 'Second private', 'fxk_', 'synthetic-csrf', 'private-path', 'source text fixture']) assert.ok(!persisted.includes(secret), 'Sensitive value persisted: ' + secret);
  checks.push('Authoritative usage/latency/held balance, read-only billing, project creation/switching, eight routes, six widths, mobile navigation and storage allowlist');

  await page.goto(base + '/app/playground'); await expect(page.locator('[data-workspace-content]')).toBeVisible(); responseState = 'network_error'; await page.locator('[data-new-request]').click(); await page.locator('[data-confirm-action]').click(); await page.locator('[data-request-url]').fill('https://approved.example/network-case'); await page.locator('[data-run-request]').click(); await expect(page.locator('[data-response-state]')).toHaveText('Unknown'); const networkPosts = fetchPosts; await page.reload(); await expect(page.locator('[data-response-state]')).toHaveText('Pending recovery'); await page.locator('[data-recover-result]').click(); await expect(page.locator('[data-response-state]')).toHaveText('Unknown'); assert.equal(fetchPosts, networkPosts);
  const pending = page.locator('[data-pending-operation]');
  const previousKeys = await pending.locator('option').evaluateAll(options => options.map(option => option.value));
  assert.equal(previousKeys.length, 2);
  let releaseFetch;
  fetchPause = new Promise(resolve => { releaseFetch = resolve; });
  responseState = 'completed';
  try {
    await page.locator('[data-new-request]').click();
    await page.locator('[data-confirm-action]').click();
    await page.locator('[data-request-url]').fill('https://approved.example/delayed-case');
    await page.locator('[data-run-request]').click();
    await expect(pending).toBeDisabled();
    await expect(pending.locator('option')).toHaveCount(3);
    await pending.evaluate((select, key) => {
      select.value = key;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, previousKeys[0]);
  } finally { releaseFetch(); fetchPause = null; }
  await expect(page.locator('[data-response-state]')).toHaveText('Completed');
  assert.deepEqual(await pending.locator('option').evaluateAll(options => options.map(option => option.value)), previousKeys);
  await page.locator('[data-inspector-tab="code"]').click();
  await page.locator('[data-project-select]').selectOption(projects[1].id);
  await expect(page.locator('[data-response-state]')).toHaveText('Ready');
  await expect(page.locator('[data-request-url]')).toHaveValue('');
  await expect(page.locator('[data-inspector-tab="output"]')).toHaveAttribute('aria-selected', 'true');
  await expect(pending).toBeHidden();
  await page.locator('[data-project-select]').selectOption(projectId);
  await expect(pending.locator('option')).toHaveCount(2);
  assert.deepEqual(await pending.locator('option').evaluateAll(options => options.map(option => option.value)), previousKeys);
  checks.push('GET-only recovery preserves uncertain keys across network errors and project switches; delayed completion clears only its own key');
  managedProjectId = projects[1].id;
  const primary = managedKey('1', 'Named fixture key');
  const secondary = managedKey('2', 'Second fixture key');
  managedKeys = [managedKey('3', 'Read only fixture', ['fetch:read']), managedKey('4', 'Revoked fixture', ['fetch:write'], '2026-11-04T00:00:00Z')];
  await page.locator('[data-project-select]').selectOption(managedProjectId);
  const urlField = page.locator('[data-request-url]'), run = page.locator('[data-run-request]');
  const routeField = page.locator('[data-request-route]'), countryField = page.locator('[data-request-country]');
  const countryFind = page.locator('[data-country-search]');
  const target = 'https://county-source.example/lookup?private=do-not-store';
  await expect(urlField).toBeVisible();
  await expect(page.locator('input[value="browser"]')).toBeEnabled();
  await expect(countryField).toBeDisabled(); await expect(countryField).toHaveText('Location not selectable');
  await urlField.fill(target);
  await expect(run).toBeDisabled(); await expect(page.locator('[data-request-key-empty] a')).toHaveAttribute('href', '/app/keys');
  assert.equal(renderPosts, 0);
  managedKeys.push(primary);
  await page.reload(); await expect(page.locator('[data-selected-key]')).toHaveText('API key: Named fixture key');
  await expect(page.locator('[data-request-key]')).toBeHidden();
  await urlField.fill('https://127.0.0.1/');
  await expect(page.locator('[data-request-quote]')).toContainText('Private destinations are unavailable.');
  await expect(urlField).toHaveAttribute('aria-invalid', 'true'); await expect(run).toBeDisabled();
  await page.locator('input[value="browser"]').check();
  await routeField.selectOption('datacenter');
  await expect(routeField.locator('option[value="residential"]')).toHaveAttribute('disabled', '');
  await expect(page.locator('[data-route-help]')).toContainText('reached a service limit');
  await countryFind.fill('United Kingdom');
  await expect(countryField.locator('option[value="GB"]')).toHaveAttribute('disabled', '');
  await countryFind.fill('United States');
  await expect(countryField.locator('option[value="US"]')).toHaveText('United States (US)');
  await countryField.selectOption('US'); await urlField.fill(target);
  await expect(page.locator('[data-request-quote]')).toContainText('Reserves up to 3 credits · cost ceiling $0.001300');
  await expect(run).toBeEnabled();
  await expect(page.locator('[data-request-profile-field]')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(urlField).toBeInViewport(); await expect(run).toBeInViewport();
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(renderPosts, 0, 'Preparing a URL and inspecting choices does not dispatch source work');
  await page.locator('[data-request-advanced] summary').click();
  await page.locator('[data-request-screenshot]').check(); await page.locator('[data-request-wait]').fill('400');
  await page.locator('[data-inspector-tab="code"]').click();
  await page.locator('[data-code-language]').selectOption('javascript');
  await expect(page.locator('[data-generated-code]')).toContainText('/v2/render');
  await expect(page.locator('[data-generated-code]')).toContainText('randomUUID()');
  await expect(page.locator('[data-generated-code]')).toContainText('"country": "US"');
  await expect(page.locator('[data-generated-code]')).toContainText('"wait_ms": 400');
  await expect(page.locator('[data-generated-code]')).not.toContainText(primary.id);
  await run.click();
  await expect(page.locator('[data-response-state]')).toHaveText('Completed');
  const renderCall = calls.findLast(call => call.method === 'POST' && call.path.endsWith('/render'));
  assert.equal(renderCall.body.key_id, undefined, 'Auto-selected sole keys are resolved and checked again on admission');
  const renderPrepare = calls.findLast(call => call.path.endsWith('/playground/prepare'));
  assert.equal(renderPrepare.body.key_id, undefined);
  assert.equal(renderCall.body.screenshot, true); assert.equal(renderCall.body.wait_ms, 400);
  assert.deepEqual(renderCall.body.proxy, { class: 'datacenter', country: 'US' });
  assert.match(renderCall.body.idempotency_key, /^render_[a-f0-9-]{36}$/);
  assert.equal(renderCall.body.url, target);
  await expect(page.locator('[data-result-source]')).toHaveText('HTTP 200');
  await expect(page.locator('[data-response-note]')).toContainText('Partial capture. 2 requests were blocked.');
  await expect(page.locator('[data-result-country]')).toHaveText('United States (US)');
  await expect(page.locator('[data-result-credits]')).toHaveText('3 used');
  await expect(page.locator('[data-result-duration]')).toHaveText('145 ms');
  await expect(page.locator('[data-generated-code]')).toContainText('randomUUID()');
  await page.locator('[data-code-operation]').selectOption('recover');
  await expect(page.locator('[data-generated-code]')).toContainText('/v2/render/' + renderCall.body.idempotency_key);
  await page.locator('[data-inspector-tab="output"]').click();
  await expect(page.locator('[data-body-description]')).toHaveText('Rendered DOM');
  await expect(page.locator('[data-response-output]')).toHaveText('<main>Managed source fixture</main>');
  await page.locator('[data-copy-body]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '<main>Managed source fixture</main>');
  const bodyDownload = page.waitForEvent('download'); await page.locator('[data-download-body]').click();
  assert.equal((await bodyDownload).suggestedFilename(), 'fetchx-body.txt');
  await page.locator('[data-inspector-tab="headers"]').click();
  await expect(page.locator('[data-response-headers]')).toContainText('"content-type": "text/html"');
  await page.locator('[data-inspector-tab="screenshot"]').click();
  await expect(page.locator('[data-browser-screenshot]')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  assert.ok(await page.locator('[data-browser-screenshot]').evaluate(image => image.complete && image.naturalWidth > 0));
  const imageDownload = page.waitForEvent('download'); await page.locator('[data-download-screenshot]').click();
  assert.equal((await imageDownload).suggestedFilename(), 'fetchx-screenshot.jpg');
  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await audit('prepared browser screenshot on mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  nextRenderState = 'unknown';
  await page.locator('[data-new-request]').click(); await expect(run).toBeEnabled(); await run.click();
  await expect(page.locator('[data-response-state]')).toHaveText('Unknown');
  await page.locator('[data-inspector-tab="code"]').click();
  await expect(page.locator('[data-response-error]')).toContainText('browser outcome is uncertain');
  const managedPosts = renderPosts;
  await page.reload();
  await expect(page.locator('[data-response-state]')).toHaveText('Pending recovery');
  await page.locator('[data-recover-result]').click();
  await expect(page.locator('[data-response-state]')).toHaveText('Unknown');
  assert.equal(renderRecoveries, 1); assert.equal(renderPosts, managedPosts);
  managedKeys.push(secondary);
  nextRenderState = 'completed';
  await page.reload();
  await page.locator('[data-new-request]').click(); await page.locator('[data-confirm-action]').click();
  await urlField.fill(target); await expect(run).toBeDisabled();
  await expect(page.locator('[data-request-key] option[value="' + secondary.id + '"]')).toContainText(secondary.name);
  await expect(page.locator('[data-request-key] option')).toHaveCount(3);
  await page.locator('[data-request-key]').selectOption(secondary.id);
  await expect(run).toBeEnabled();
  await page.locator('[data-request-advanced] summary').click();
  await page.locator('[data-request-method]').selectOption('HEAD');
  await page.locator('[data-request-header="accept-language"]').fill('en-US');
  await expect(run).toBeEnabled();
  await run.click(); await expect(page.locator('[data-response-state]')).toHaveText('Completed');
  const nativeCall = calls.findLast(call => call.method === 'POST' && call.path === '/projects/' + managedProjectId + '/fetch');
  assert.equal(nativeCall.body.key_id, secondary.id); assert.equal(nativeCall.body.method, 'HEAD');
  assert.deepEqual(nativeCall.body.headers, { 'accept-language': 'en-US' });
  assert.equal(nativeCall.body.screenshot, undefined);
  const managedStorage = await storage();
  for (const value of [target, primary.id, secondary.id, 'Managed source fixture', 'en-US', testJpeg]) assert.ok(!managedStorage.includes(value));
  checks.push('Prepared public URL, direct location semantics, searched US proxy, one/multiple/zero eligible keys, Browser artifacts and recovery, HTTP headers and selected-key attribution without storing source or key data');
  // An origin-specific rate can be invisible in the project matrix. Resolve the
  // URL first without silently selecting an unavailable route or proxy location.
  targetPriced = true; managedKeys = [primary];
  await page.reload();
  await page.locator('[data-new-request]').click(); await page.locator('[data-confirm-action]').click();
  await expect(page.locator('input[value="browser"]')).toBeDisabled();
  await urlField.fill(target);
  await expect(routeField.locator('option[value="datacenter"]')).not.toHaveAttribute('disabled');
  await expect(page.locator('input[value="browser"]')).toBeEnabled(); await expect(run).toBeDisabled();
  await expect(routeField).toHaveValue('');
  await routeField.selectOption('datacenter'); await countryField.selectOption('US'); await expect(run).toBeEnabled();
  let releasePrepare;
  preparePause = new Promise(resolve => { releasePrepare = resolve; });
  const prepareCount = prepareCalls;
  try {
    await urlField.fill('https://county-source.example/defer-this-quote');
    await expect.poll(() => prepareCalls).toBeGreaterThan(prepareCount);
    await expect(run).toBeDisabled();
    await urlField.fill(target);
    await expect(run).toBeEnabled();
  } finally { releasePrepare(); preparePause = null; }
  await page.locator('[data-inspector-tab="code"]').click();
  await expect(page.locator('[data-generated-code]')).toContainText('private=do-not-store');
  await expect(page.locator('[data-generated-code]')).not.toContainText('defer-this-quote');
  managedKeys.push(secondary); // A second key appears after the sole-key quote.
  const sourceCalls = renderPosts;
  await run.click();
  await expect(page.locator('[data-response-state]')).toHaveText('Rejected');
  await expect(page.locator('[data-response-error]')).toHaveText('Choose a project API key.');
  assert.equal(renderPosts, sourceCalls, 'A now-ambiguous auto selection must be rejected before dispatch');
  assert.equal(calls.findLast(call => call.method === 'POST' && call.path.endsWith('/fetch')).body.key_id, undefined);
  await page.locator('[data-new-request]').click(); await page.locator('[data-confirm-action]').click();
  await expect(page.locator('[data-request-key]')).toHaveValue('');
  await expect(run).toBeDisabled();
  await page.locator('[data-request-key]').selectOption(secondary.id); await expect(run).toBeEnabled();
  checks.push('URL refreshes an initially unavailable target-priced matrix; stale quotes cannot overwrite the current draft; a new key makes auto admission refuse safely until a key is chosen');
  // A failed logout retains the authenticated UI; a pending request cannot be duplicated.
  await page.setViewportSize({ width: 360, height: 800 });
  const signout = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signout).toBeInViewport();
  let releaseLogout; logoutPause = new Promise(resolve => { releaseLogout = resolve; }); logoutFailure = true;
  const logoutCount = calls.filter(call => call.path === '/auth/logout').length;
  await signout.click(); await expect(page.getByRole('button', { name: 'Signing out…', exact: true })).toBeDisabled();
  await expect(page.locator('[data-logout]')).toHaveAttribute('aria-busy', 'true');
  await page.locator('[data-logout]').evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.equal(calls.filter(call => call.path === '/auth/logout').length, logoutCount + 1);
  releaseLogout(); await expect(page.locator('[data-page-error]')).toContainText('Sign out is temporarily unavailable');
  await expect(signout).toBeEnabled(); await expect(page.locator('[data-user-email]')).toHaveText(user.email);
  assert.equal(new URL(page.url()).pathname, '/app/playground'); assert.equal(signedIn, true);
  logoutPause = null; logoutFailure = false;
  await signout.click(); await expect(page).toHaveURL(base + '/login'); await expect(page.locator('[data-signup-email] button')).toBeEnabled();
  await page.goto(base + '/app'); await expect(page.locator('[data-gate-title]')).toHaveText('Sign in to continue.'); await expect(page.locator('[data-session-account]')).toBeHidden();
  signedIn = true; await page.goto(base + '/login'); await expect(page.locator('[data-auth-account] [data-user-email]')).toHaveText(user.email);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.locator('[data-signup-email] button')).toBeEnabled(); assert.equal(signedIn, false);
  checks.push('Key samples clear on focus without clearing typed names; signed-in identity and signout visible across widths; pending logout blocks duplicate requests, failure retains session, successful workspace/auth logout returns to sign-in');
  enabled = false; await page.goto(base + '/signup'); await expect(page.locator('[data-page-error]')).toContainText('not configured'); await expect(page.locator('[data-signup-email] button')).toBeDisabled(); await page.goto(base + '/app'); await expect(page.locator('[data-gate-title]')).toHaveText('Workspace unavailable.'); await expect(page.locator('[data-workspace-content]')).toBeHidden();
  checks.push('Unconfigured service fails honestly with no synthetic account, usage or request success');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await fs.writeFile(out + '/product-checks.json', JSON.stringify({ checks, accessibility, errors, externalRequests: external, fixtureApiCalls: calls.map(({ method, path }) => ({ method, path })) }, null, 2));
  console.log(JSON.stringify({ checks, accessibility, errors, externalRequests: external }));
  if (accessibility.some(result => result.violations.length)) process.exitCode = 1;
} finally { await browser.close(); }
