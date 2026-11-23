// Admin portal Feedback tab against a synthetic control API: open reports
// first, filters, a report's detail with FetchX's attempts, saving a status
// and reply, and the jump to site knowledge, with an accessibility audit.
// Report text is rendered as text, never as HTML.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4328';
const out = process.env.TEST_OUTPUT_DIR || '.local/browser-reports';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.TEST_CHROME_CHANNEL ? { channel: process.env.TEST_CHROME_CHANNEL } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const errors = [], external = [], checks = [], saves = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => { errors.push('unexpected dialog: ' + dialog.message()); void dialog.dismiss(); });
page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.push(request.url()); });

const report = (id, fields) => ({ id, kind: 'blocked_via_fetchx_ok_from_home', fetch_id: null, url: 'https://shop.example.com/a', method: 'GET', message: null,
  evidence: {}, status: 'received', reply: null, created_at: '2026-11-23T09:00:00.000Z', updated_at: '2026-11-23T09:00:00.000Z',
  project: 'cp_22222222-2222-4222-8222-222222222222', project_name: 'Studio', key_id: null, host: 'shop.example.com', fetch: null, reviewed_by: null, ...fields });
const feedback = [
  report('aaaaaaaa-1111-4111-8111-111111111111', { fetch_id: '7d1e9a52-3c4b-4f6e-8a2d-9b0c1e2f3a4b', method: null, url: 'https://shop.example.com/search?q=lamps',
    message: 'Loads at home <img src=x onerror=alert(1)>', key_id: '33333333-3333-4333-8333-333333333333',
    evidence: { status_code: 200, content_type: 'text/html', body_excerpt: '<title>Lamps | Shop</title>', client: 'curl 8.5, home connection in DE' },
    fetch: { status: 'failed', page_status: 'challenge', error_code: 'blocked', challenge: 'datadome', created_at: '2026-11-23T08:59:00.000Z', finished_at: '2026-11-23T08:59:40.000Z',
      attempts: [{ transport: 'http', class: 'direct', country: null, result: 'blocked', code: null, challenge: 'datadome', status_code: 403 },
        { transport: 'browser', class: 'residential', country: 'US', result: 'blocked', code: 'wall_stayed', challenge: 'datadome', status_code: 403 }] } }),
  report('bbbbbbbb-2222-4222-8222-222222222222', { kind: 'extract_wrong', host: 'docs.example.org', url: 'https://docs.example.org/x', status: 'reviewing' }),
  report('cccccccc-3333-4333-8333-333333333333', { kind: 'other', status: 'resolved', reply: 'Explained.', reviewed_by: 'ops@example.test' }),
];
await page.route('**/api/control/**', async route => {
  const request = route.request(), method = request.method(), path = new URL(request.url()).pathname.replace('/api/control', '');
  const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (path === '/session') return send({ user: { id: '11111111-1111-4111-8111-111111111111', email: 'ops@example.test' }, csrf_token: 'synthetic-csrf-admin-fixture', projects: [] });
  if (path === '/admin/session') return send({ operator: true, email: 'ops@example.test' });
  if (path === '/admin/rules') return send({ rules: [], providers: ['oxylabs'] });
  if (path === '/admin/sites') return send({ sites: [{ host: 'shop.example.com', routes: 2, proven: 0, cooling: 1, failing: 1, updated_at: '2026-11-23T09:00:00.000Z' }] });
  if (path === '/admin/sites/shop.example.com') return send({ routes: [{ execution: 'browser', proxy_class: 'residential', country: 'US', provider: 'dataimpulse', state: 'cooling', successes: 0, failures: 3, last_outcome: 'blocked', retry_not_before: null }] });
  if (path === '/admin/feedback' && method === 'GET') return send({ feedback });
  const one = /^\/admin\/feedback\/([0-9a-f-]{36})$/.exec(path);
  if (one && method === 'PUT') {
    assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf-admin-fixture', 'a save carries the CSRF token');
    const body = request.postDataJSON(); saves.push(body);
    const row = feedback.find(item => item.id === one[1]);
    Object.assign(row, body, { reviewed_by: 'ops@example.test', updated_at: '2026-11-23T10:00:00.000Z' });
    return send({ feedback: row });
  }
  return send({ error: { code: 'route_not_found', message: 'No such fixture route.' } }, 404);
});

try {
  await page.goto(base + '/app/admin');
  await expect(page.locator('[data-admin-who]')).toHaveText('Operator · ops@example.test');
  await page.getByRole('tab', { name: 'Feedback' }).click();
  const rows = page.locator('[data-feedback-body] tr');
  await expect(rows).toHaveCount(2); await expect(page.locator('[data-feedback-count]')).toHaveText('2 of 3');
  await expect(rows.first()).toContainText('shop.example.com'); await expect(rows.first()).toContainText('failed · blocked · datadome');
  await expect(rows.first()).toContainText('2 attempts: blocked'); await expect(rows.first()).toContainText('HTTP 200');
  await page.locator('[data-feedback-status]').selectOption(''); await expect(rows).toHaveCount(3);
  await page.locator('[data-feedback-host]').fill('docs.'); await expect(rows).toHaveCount(1); await expect(rows.first()).toContainText('Extraction wrong');
  await page.locator('[data-feedback-host]').fill('nothing.example'); await expect(rows.first()).toHaveText('No reports match these filters.');
  await page.locator('[data-feedback-host]').fill(''); await page.locator('[data-feedback-status]').selectOption('open');
  checks.push('Open reports first, filtered by status and host, with what FetchX did and what the caller saw');

  await rows.first().getByRole('button', { name: 'Review' }).click();
  const form = page.locator('[data-feedback-form]');
  await expect(form).toBeVisible(); await expect(page.locator('[data-feedback-title]')).toHaveText('Blocked via FetchX, fine from their connection · shop.example.com');
  await expect(page.locator('[data-feedback-summary]')).toContainText('Loads at home <img src=x onerror=alert(1)>');
  await expect(page.locator('[data-feedback-summary]')).toContainText('Studio (cp_22222222-2222-4222-8222-222222222222)');
  await expect(page.locator('[data-feedback-excerpt]')).toHaveText('<title>Lamps | Shop</title>');
  await expect(page.locator('[data-feedback-attempts] tr')).toHaveCount(2); await expect(page.locator('[data-feedback-attempts] tr').nth(1)).toContainText('wall_stayed');
  assert.equal(await page.locator('[data-feedback-form] img').count(), 0, 'report text is not HTML');
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('[data-panel="feedback"]').analyze();
  await form.locator('select[name="status"]').selectOption('resolved'); await form.locator('textarea[name="reply"]').fill('  Fixed: DE residential first. ');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-admin-toast]')).toHaveText('Report saved.'); await expect(form).toBeHidden();
  assert.deepEqual(saves, [{ status: 'resolved', reply: 'Fixed: DE residential first.' }]);
  await expect(rows).toHaveCount(1); await expect(page.locator('[data-feedback-count]')).toHaveText('1 of 3');
  checks.push('A report shows the caller\'s evidence and every attempt as text; saving sends the status and the trimmed reply, and the report leaves the open list');

  await page.locator('[data-feedback-status]').selectOption('resolved');
  await rows.filter({ hasText: 'search?q=lamps' }).getByRole('button', { name: 'Review' }).click();
  await expect(form.locator('textarea[name="reply"]')).toHaveValue('Fixed: DE residential first.');
  await page.locator('[data-feedback-site]').click();
  await expect(page.locator('[data-panel="sites"]')).toBeVisible(); await expect(page.locator('[data-site-title]')).toHaveText('Routes · shop.example.com');
  checks.push('Site knowledge opens the reported host\'s routes');

  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await fs.writeFile(out + '/admin-feedback-checks.json', JSON.stringify({ checks, violations: audit.violations, errors, externalRequests: external }, null, 2));
  console.log(JSON.stringify({ checks, violations: audit.violations.length }));
  if (audit.violations.length) { console.error(JSON.stringify(audit.violations, null, 2)); process.exitCode = 1; }
} finally { await browser.close(); }
