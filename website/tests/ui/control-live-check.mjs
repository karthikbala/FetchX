// Live check: a real browser -> the Pages bridge -> a local gateway started with
// `node scripts/control-preview.mjs --fixture ...` (offline fixture site). Nothing
// is mocked between the page and the gateway, and no real site is contacted.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const mailbox = process.env.CONTROL_PREVIEW_MAILBOX || join(repository, '.local/console-preview/mailbox.jsonl');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4331';
const email = `live-${Date.now()}@example.test`;
const browser = await chromium.launch();
const page = await (await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })).newPage();
const errors = [], external = [], violations = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.push(request.url()); });
const audit = async name => {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  if (result.violations.length) violations.push({ name, ids: result.violations.map(item => item.id) });
};
async function code(challengeAfter) {
  for (let i = 0; i < 50; i++) {
    const lines = (await readFile(mailbox, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const found = lines.findLast(line => line.email === email && lines.indexOf(line) >= challengeAfter);
    if (found) return found.code;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('No code in the local mailbox');
}

try {
  const before = (await readFile(mailbox, 'utf8')).trim().split('\n').filter(Boolean).length;
  await page.goto(base + '/signup');
  await page.locator('[data-signup-email] input').fill(email); await page.locator('[data-signup-email] button').click();
  await expect(page.locator('[data-signup-stage="1"]')).toBeVisible();
  await page.locator('[data-signup-verify] input').fill(await code(before)); await page.locator('[data-signup-verify] button').click();
  await page.locator('[data-signup-project] input').fill('Live check'); await page.locator('[data-signup-project] button').click();
  await page.locator('[data-signup-key] input[name="name"]').fill('Live key'); await page.locator('[data-signup-key] button').click();
  await expect(page.locator('[data-signup-secret]')).toContainText('fxk_');
  const token = await page.locator('[data-signup-secret]').textContent();

  await page.goto(base + '/app/playground');
  await expect(page.locator('[data-credit-total]').first()).toHaveText('1,000');
  await page.locator('[data-playground-form] input[name="url"]').fill('https://shop.example.com/success');
  await page.locator('[data-run-request]').click();
  await expect(page.locator('[data-response-state]')).toHaveText('succeeded', { timeout: 30_000 });
  await expect(page.locator('[data-response-output]')).toContainText('Offline fixture');
  await expect(page.locator('[data-result-credits]')).toHaveText('1');
  await expect(page.locator('[data-credit-total]').first()).toHaveText('999');
  await audit('playground');
  await page.locator('[data-playground-form] input[name="url"]').fill('https://shop.example.com/forbidden');
  await page.locator('.pp-request-advanced summary').click();
  await page.locator('[data-playground-form] select[name="route"]').selectOption('direct');
  await page.locator('[data-run-request]').click();
  await expect(page.locator('[data-response-state]')).toHaveText('failed', { timeout: 30_000 });
  await expect(page.locator('[data-result-credits]')).toHaveText('0');
  await expect(page.locator('[data-credit-total]').first()).toHaveText('999');

  await page.goto(base + '/app/requests');
  await expect(page.locator('.pp-request-link')).toHaveCount(2);
  await page.locator('.pp-request-link').first().click();
  await expect(page.locator('[data-request-detail]')).toContainText('"status"');
  await audit('requests');
  await page.locator('[data-close-request]').click();

  await page.goto(base + '/app/billing');
  await expect(page.locator('[data-usage-succeeded]')).toHaveText('1');
  await expect(page.locator('[data-usage-failed]')).toHaveText('1');
  await audit('billing');

  // The key from sign-up works against the public API on the gateway.
  const api = await fetch('http://127.0.0.1:8789/v1/usage', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(api.status, 200);
  assert.equal((await api.json()).used.credits, 1);

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(base + '/login');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(violations, []);
  console.log('Live console check passed: sign-up by mailbox code, key, playground success and free failure, requests, usage, API key, sign-out.');
} finally {
  await browser.close();
}
