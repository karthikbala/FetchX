// UI contract smoke tests use synthetic control API responses. The separate local
// integration harness verifies the journey against the real gateway and database.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4328';
const out = process.env.TEST_OUTPUT_DIR || '.local/browser-reports';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [], external = [], checks = [], accessibility = [], calls = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.push(request.url()); });
let signedIn = false, enabled = true, responseState = 'completed', recoveryMissing = false;
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'private-fixture@example.test' };
const projectId = 'cp_22222222-2222-4222-8222-222222222222';
const projects = [], keys = [], operations = [], envelopes = new Map();
let keyNumber = 0, fetchPosts = 0, recoveries = 0;
const token = () => 'fxk_SYNTHETIC_UI_FIXTURE_' + keyNumber;
const credits = () => ({ granted: 20, available: 20 - fetchPosts, settled: responseState === 'completed' ? fetchPosts : Math.max(0, fetchPosts - 1), held: responseState === 'unknown' ? 1 : 0, reserved: 0, released: 0, commercial_enabled: false });
const session = () => ({ user, csrf_token: 'synthetic-csrf-ui-fixture', projects });
const safeProject = name => ({ id: projects.length ? 'cp_33333333-3333-4333-8333-333333333333' : projectId, name, status: 'active', created_at: '2026-11-02T10:00:00Z' });
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
  if (path === '/auth/logout') { signedIn = false; return send({ logged_out: true }); }
  if (path === '/projects' && method === 'POST') { const project = safeProject(body.name); projects.push(project); return send({ project }, 201); }
  if (path === '/projects') return send({ projects });
  const match = /^\/projects\/([^/]+)(.*)$/.exec(path);
  if (!match) return fail('route_not_found', 'Unknown route.', 404);
  const project = projects.find(item => item.id === match[1]), resource = match[2];
  if (!project) return fail('project_forbidden', 'Project not found.', 404);
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
  await page.locator('[data-signup-key] input[value="usage:read"]').uncheck(); await page.locator('[data-signup-key] button').click();
  await expect(page.locator('[data-signup-secret]')).toContainText(token()); assert.ok(!keys[0].scopes.includes('usage:read'));
  await page.locator('[data-signup-copy]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token());
  await audit('verified signup key reveal');
  await page.locator('[data-finish-signup]').click(); await expect(page.locator('[data-run-request]')).toBeEnabled();
  await expect(page.locator('input[value="browser"]')).toBeDisabled(); await expect(page.locator('[data-request-country]')).toBeDisabled();
  assert.equal(await page.locator('[data-request-route] option').count(), 1);
  await page.locator('[data-request-url]').fill('https://approved.example/private-path'); await page.locator('[data-run-request]').click();
  await expect(page.locator('[data-response-state]')).toHaveText('Completed');
  await expect(page.locator('[data-response-output]')).toContainText('<img src='); assert.equal(await page.locator('.pp-response-panel img').count(), 0);
  assert.equal(fetchPosts, 1); await expect(page.locator('[data-run-request]')).toBeDisabled();
  await page.locator('[data-inspector-tab="code"]').click(); await expect(page.locator('[data-generated-code]')).toContainText('/v2/fetch/console_');
  for (const language of ['curl', 'javascript', 'python']) { await page.locator('[data-code-language]').selectOption(language); await page.locator('[data-copy-code]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.locator('[data-generated-code]').textContent()); }
  await page.locator('[data-inspector-tab="output"]').focus(); await page.keyboard.press('ArrowRight'); await expect(page.locator('[data-inspector-tab="diagnostics"]')).toBeFocused();
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
  await page.reload(); await expect(page.locator('[data-response-state]')).toHaveText('Pending recovery'); assert.equal(fetchPosts, postsBefore);
  recoveryMissing = true; await page.locator('[data-recover-result]').click(); await expect(page.locator('[data-response-state]')).toHaveText('Rejected'); assert.ok((await storage()).includes('console_'), 'A not-found lookup must retain the pending key'); recoveryMissing = false;
  await page.locator('[data-recover-result]').click(); await expect(page.locator('[data-response-state]')).toHaveText('Unknown'); assert.equal(fetchPosts, postsBefore); assert.equal(recoveries, 2);
  assert.ok((await storage()).includes('console_'));
  await page.locator('[data-new-request]').click(); await expect(page.locator('[data-confirm-dialog]')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click(); await expect(page.locator('[data-run-request]')).toBeDisabled();
  await page.locator('[data-new-request]').click(); await page.locator('[data-confirm-action]').click(); await expect(page.locator('[data-run-request]')).toBeEnabled(); assert.equal(fetchPosts, postsBefore);
  checks.push('Unknown outcome survives reload, GET recovery only, no automatic retry, explicit new request confirmation and retained operation key');

  await page.goto(base + '/app/requests'); await expect(page.locator('[data-request-id]')).toHaveCount(2); await page.locator('[data-request-id]').first().click(); await expect(page.locator('[data-request-dialog]')).toBeVisible(); await expect(page.locator('[data-request-detail]')).toContainText('source_timeout_unknown'); await expect(page.locator('[data-request-detail]')).toHaveAttribute('tabindex', '0'); await expect(page.locator('[data-request-detail]')).toHaveAccessibleName('Retained response text'); await audit('retained request details'); await page.keyboard.press('Escape');
  await page.locator('[data-request-filter]').selectOption('completed'); await expect(page.locator('[data-request-id]')).toHaveCount(1); await page.locator('[data-request-search]').fill('no-match'); await expect(page.locator('[data-request-id]')).toHaveCount(0);
  await page.goto(base + '/app/keys'); await expect(page.locator('[data-key-secret]')).toHaveText('Concealed'); await page.locator('[data-create-key] input[name="name"]').fill('Fixture server key'); await page.locator('[data-create-key] button[type="submit"]').click(); await expect(page.locator('[data-key-dialog]')).toBeVisible(); await audit('key reveal');
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
    for (const width of [360, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route + ' overflows at ' + width); }
    await audit(route); if (route === '/app') await page.screenshot({ path: out + '/live-workspace-overview.png', fullPage: true });
  }
  await page.setViewportSize({ width: 360, height: 800 }); await page.locator('[data-app-menu]').click(); await expect(page.locator('[data-app-menu]')).toHaveAttribute('aria-expanded', 'true'); await page.keyboard.press('Escape'); await expect(page.locator('[data-app-menu]')).toHaveAttribute('aria-expanded', 'false');
  const persisted = await storage(); for (const secret of [user.email, 'Private project', 'Second private', 'fxk_', 'synthetic-csrf', 'private-path', 'source text fixture']) assert.ok(!persisted.includes(secret), 'Sensitive value persisted: ' + secret);
  checks.push('Authoritative usage/latency/held balance, read-only billing, project creation/switching, eight routes, four widths, mobile navigation and storage allowlist');

  await page.goto(base + '/app/playground'); await expect(page.locator('[data-workspace-content]')).toBeVisible(); responseState = 'network_error'; await page.locator('[data-new-request]').click(); await page.locator('[data-confirm-action]').click(); await page.locator('[data-request-url]').fill('https://approved.example/network-case'); await page.locator('[data-run-request]').click(); await expect(page.locator('[data-response-state]')).toHaveText('Unknown'); const networkPosts = fetchPosts; await page.reload(); await expect(page.locator('[data-response-state]')).toHaveText('Pending recovery'); await page.locator('[data-recover-result]').click(); await expect(page.locator('[data-response-state]')).toHaveText('Unknown'); assert.equal(fetchPosts, networkPosts);
  checks.push('Interrupted network response retains its original key and recovers with GET; missing lookup cannot discard an uncertain operation');
  enabled = false; await page.goto(base + '/signup'); await expect(page.locator('[data-page-error]')).toContainText('not configured'); await expect(page.locator('[data-signup-email] button')).toBeDisabled(); await page.goto(base + '/app'); await expect(page.locator('[data-gate-title]')).toHaveText('Workspace unavailable.'); await expect(page.locator('[data-workspace-content]')).toBeHidden();
  checks.push('Unconfigured service fails honestly with no synthetic account, usage or request success');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await fs.writeFile(out + '/product-checks.json', JSON.stringify({ checks, accessibility, errors, externalRequests: external, fixtureApiCalls: calls.map(({ method, path }) => ({ method, path })) }, null, 2));
  console.log(JSON.stringify({ checks, accessibility, errors, externalRequests: external }));
  if (accessibility.some(result => result.violations.length)) process.exitCode = 1;
} finally { await browser.close(); }
