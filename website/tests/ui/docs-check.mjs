import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { docPages } from '../../src/data/api-docs.ts';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4328';
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto(base + '/docs');
  await page.keyboard.press('/');
  const search = page.getByRole('searchbox', { name: 'Search docs' });
  assert.ok(await search.evaluate(input => document.activeElement === input));
  await search.fill('/v2/fetch');
  const fetchResult = page.locator('[data-doc-search-results] a[href="/docs/fetch"]');
  assert.ok(await fetchResult.isVisible());
  await search.fill('zzunmatchedzz');
  assert.match(await page.locator('[data-doc-search-status]').innerText(), /no matching/i);
  await search.press('Escape');
  assert.ok(await page.getByRole('navigation', { name: 'API documentation' }).isVisible());

  const example = page.locator('[data-doc-code]').filter({ has: page.getByRole('tablist') }).first();
  const tabs = example.getByRole('tab');
  assert.ok(await tabs.count() >= 3);
  const panels = example.getByRole('tabpanel');
  for (let index = 0; index < await tabs.count(); index++) {
    const tab = tabs.nth(index);
    if (index === 0) await tab.focus();
    else await page.keyboard.press('ArrowRight');
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    const expected = await panels.locator('code').textContent();
    await example.getByRole('button', { name: /^Copy / }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
    await tab.focus();
  }

  await page.setViewportSize({ width: 360, height: 800 });
  const menu = page.locator('[data-doc-menu]');
  await menu.locator('summary').click();
  await menu.locator('nav a[href="/docs/fetch"]').click();
  assert.equal(new URL(page.url()).pathname, '/docs/fetch');
  assert.ok(await page.locator('article h1').isVisible());

  const staticPage = await browser.newPage({ javaScriptEnabled: false });
  for (const doc of docPages) {
    const route = doc.slug ? '/docs/' + doc.slug : '/docs';
    await staticPage.goto(base + route);
    assert.equal(await staticPage.locator('h1').innerText(), doc.title);
    for (const section of doc.sections) {
      assert.ok(await staticPage.locator('article section').evaluateAll(
        (sections, id) => sections.some(item => item.id === id), section.id
      ), 'Missing section ' + route + '#' + section.id);
    }
  }
  console.log('Docs search, keyboard tabs, clipboard, mobile navigation and static content passed.');
} finally {
  await browser.close();
}
