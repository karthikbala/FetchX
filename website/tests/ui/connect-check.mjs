// All API responses and account data are synthetic. The page and headers come from Pages.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4328';
const requestId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const thirdId = '55555555-5555-4555-8555-555555555555';
const archived = { id: 'cp_44444444-4444-4444-8444-444444444444', name: 'Archived project', status: 'archived' };
const created = { id: 'cp_66666666-6666-4666-8666-666666666666', name: 'Synthetic coding agent', status: 'active' };
const email = 'synthetic@example.test', csrf = 'c'.repeat(43), approvalCode = 'TEST-CODE';
const requested = { credits_per_day: 100, credits_per_month: null, expires_at: '2030-01-01T00:00:00.000Z' };
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 360, height: 900 }, timezoneId: 'UTC' });
  const page = await context.newPage();
  let enabled = false, signedIn = false;
  const projects = [archived], calls = [], decisions = [];
  const states = new Map([[requestId, 'pending'], [secondId, 'pending'], [thirdId, 'pending']]);
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.route('**/api/control/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/control'.length);
    const send = (json, status = 200) => route.fulfill({ status, json });
    const session = () => ({ user: { id: requestId, email }, csrf_token: csrf, projects });
    calls.push(path);
    if (path === '/status') return send({ enabled: true, mail_configured: true, ...(enabled ? { connect_enabled: true } : {}) });
    if (path === '/session') return signedIn ? send(session()) : send({ error: { code: 'unauthorized' } }, 401);
    if (path === '/auth/code') return send({ challenge_id: 'fixture-email-challenge' });
    if (path === '/auth/verify') { signedIn = true; return send(session()); }
    assert.equal(request.headers()['x-csrf-token'], csrf);
    const body = request.postDataJSON();
    assert.ok(states.has(body.request_id));
    if (path === '/connect/review') {
      assert.deepEqual(Object.keys(body), ['request_id']);
      // The first request asks for limits; the others come from a service that sends none.
      return send({ state: states.get(body.request_id), client_name: 'Synthetic coding agent', scopes: ['fetch:read', 'fetch:write', 'profiles:read'], expires_at: '2030-01-01T00:00:00Z',
        ...(body.request_id === requestId ? { limits: requested } : {}) });
    }
    if (path === '/connect/decision') {
      decisions.push(body);
      if (body.user_code !== approvalCode) return send({ error: { code: 'connect_code_invalid' } }, 400);
      const state = body.decision === 'approve' ? 'approved' : 'denied';
      if (body.project_name) projects.push(created);
      states.set(body.request_id, state);
      return send({ state });
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  });

  const document = await page.goto(`${base}/connect#invalid`);
  const headers = await document.allHeaders();
  assert.match(headers['x-robots-tag'], /noindex/);
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.match(headers['content-security-policy'], /script-src 'self';/);
  await expect(page.getByRole('status')).toHaveText(/Open the approval link/);
  assert.equal(calls.length, 0);
  // The link carries the code (verification_uri_complete); it survives signing in.
  const approvalUrl = `${base}/connect#${requestId}&code=${approvalCode}`;
  await page.goto(approvalUrl);
  await expect(page.getByRole('status')).toHaveText(/Connect is unavailable/);
  assert.deepEqual(calls, ['/status']);

  enabled = true;
  await page.getByRole('button', { name: 'Check again' }).click();
  await page.getByRole('link', { name: 'Sign in to review' }).click();
  await expect(page).toHaveURL(`${base}/login`);
  await page.getByRole('textbox', { name: /Email address/ }).fill(email);
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page.getByRole('textbox', { name: /Verification code/ }).fill('12345678');
  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page).toHaveURL(approvalUrl);
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText('Synthetic coding agent').first()).toBeVisible();
  // No active project: approving creates one, named after the client.
  const code = page.getByRole('textbox', { name: 'Code shown by your agent', exact: true });
  const projectName = page.getByRole('textbox', { name: 'New project name' });
  const create = page.getByRole('button', { name: 'Create project and approve' });
  const perDay = page.getByRole('spinbutton', { name: 'Credits per day' }), perMonth = page.getByRole('spinbutton', { name: 'Credits per month' });
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeHidden();
  await expect(projectName).toHaveValue('Synthetic coding agent');
  await expect(code).toHaveValue(approvalCode);
  await expect(page.getByText('This code came with your link')).toBeVisible();
  await expect(page.getByText(/Up to 100 credits a day, expires/)).toBeVisible();
  await expect(perDay).toHaveValue('100');
  await expect(perMonth).toHaveValue('');
  await expect(page.getByLabel('Expires', { exact: true })).toHaveValue('2030-01-01T00:00');
  await expect(create).toBeEnabled();
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(audit.violations.map(item => item.id), []);
  await perDay.fill('0');
  await create.click();
  await expect(page.getByRole('alert')).toHaveText(/Credits per day must be a whole number/);
  assert.equal(decisions.length, 0);
  await perDay.fill('');
  await perMonth.fill('2000');
  await create.click();
  await expect(page.getByRole('status')).toHaveText(/Connection approved/);
  assert.deepEqual(decisions.at(-1), { request_id: requestId, user_code: approvalCode, decision: 'approve', project_name: 'Synthetic coding agent',
    limits: { credits_per_day: null, credits_per_month: 2000, expires_at: requested.expires_at } });

  // A plain link: the user types the code and picks a project, or makes a new one.
  await page.goto(`${base}/connect#${secondId}`);
  const picker = page.getByRole('combobox', { name: 'Project', exact: true });
  const approve = page.getByRole('button', { name: 'Approve connection' });
  await expect(picker).toHaveValue('');
  await expect(picker.getByRole('option')).toHaveText(['Choose a project', created.name, 'Create a new project']);
  await expect(page.getByText('fetch:write', { exact: true })).toBeVisible();
  await expect(page.getByText(/No limits: the key can spend/)).toBeVisible();
  await expect(code).toHaveValue('');
  await expect(projectName).toBeHidden();
  await picker.selectOption('new');
  await expect(projectName).toBeVisible();
  await expect(create).toBeVisible();
  await picker.selectOption(created.id);
  await expect(projectName).toBeHidden();
  await code.fill('WRNG-CODE');
  await code.press('Enter');
  assert.equal(decisions.length, 1);
  await approve.click();
  await expect(page.getByRole('alert')).toHaveText(/code could not be verified/);
  await expect(code).toHaveValue('');
  await code.fill(approvalCode.toLowerCase());
  await approve.click();
  await expect(page.getByRole('status')).toHaveText(/Connection approved/);
  assert.deepEqual(decisions.at(-1), { request_id: secondId, user_code: approvalCode, decision: 'approve', project_id: created.id,
    limits: { credits_per_day: null, credits_per_month: null, expires_at: null } });

  await page.goto(`${base}/connect#${thirdId}`);
  await expect(picker).toHaveValue('');
  await code.fill(approvalCode);
  await page.getByRole('button', { name: 'Deny request' }).click();
  await expect(page.getByRole('status')).toHaveText(/Connection denied/);
  assert.deepEqual(decisions.at(-1), { request_id: thirdId, user_code: approvalCode, decision: 'deny' });
  assert.equal(calls.some(path => path === '/connect/start' || path === '/connect/claim'), false);
  const saved = await page.evaluate(() => JSON.stringify({ session: Object.entries(sessionStorage), local: Object.entries(localStorage) }));
  for (const privateValue of [approvalCode, csrf, email]) assert.ok(!saved.includes(privateValue));
  console.log('FetchX Connect browser fixture passed');
} finally { await browser.close(); }
