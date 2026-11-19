import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { docPages } from '../../src/data/api-docs.ts';
import contract from '../../../docs/openapi.json' with { type: 'json' };

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

  const specification = await context.request.get(base + '/openapi.json');
  assert.equal(specification.status(), 200);
  assert.match(specification.headers()['content-type'], /^application\/json\b/);
  assert.deepEqual(await specification.json(), contract);

  const renderPage = await context.newPage();
  await renderPage.goto(base + '/docs/render');
  assert.match(await renderPage.locator('.docs-endpoint').innerText(), /POST\s+\/v2\/render/);
  assert.match(await renderPage.locator('#availability').innerText(), /fetch:write/);
  assert.match(await renderPage.locator('#availability').innerText(), /features\.browser_render/);
  assert.match(await renderPage.locator('#recovery').innerText(), /GET \/v2\/render\/\{key\}/);
  const renderRequest = contract.paths['/v2/render'].post.requestBody.content['application/json'].examples.example.value;
  assert.deepEqual(JSON.parse(await renderPage.locator('#request [data-doc-code] code').first().textContent()), renderRequest);
  assert.match(await renderPage.locator('#request tr').filter({ hasText: 'wait_ms' }).innerText(), /Maximum 15000/);
  assert.match(await renderPage.locator('#request tr').filter({ hasText: 'proxy.class' }).innerText(), /direct.*datacenter.*residential/);
  await renderPage.goto(base + '/docs/reference');
  assert.ok(await renderPage.locator('#endpoints a[href="/openapi.json"]').isVisible());
  assert.match(await renderPage.locator('#endpoints tr').filter({ has: renderPage.getByRole('cell', { name: 'POST /v2/render', exact: true }) }).innerText(), /fetch:write/);
  const limit = renderPage.locator('#listOperations').getByRole('row').filter({
    has: renderPage.getByRole('cell', { name: 'limit', exact: true }),
  }).filter({
    has: renderPage.getByRole('cell', { name: 'query', exact: true }),
  });
  assert.match(await limit.innerText(), /Default is 25.*Minimum 1.*Maximum 50/s);
  const renderMarkdown = await context.request.get(base + '/docs/render.md');
  assert.equal(renderMarkdown.status(), 200);
  const markdown = await renderMarkdown.text();
  assert.match(markdown, /`POST \/v2\/render`/);
  assert.ok(markdown.includes(JSON.stringify(renderRequest, null, 2)));
  await renderPage.close();

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
  // A click can finish at navigation commit while the new HTML is still parsing.
  await Promise.all([
    page.waitForURL(base + '/docs/fetch', { waitUntil: 'domcontentloaded' }),
    menu.locator('nav a[href="/docs/fetch"]').click(),
  ]);
  assert.equal(new URL(page.url()).pathname, '/docs/fetch');
  await page.locator('article h1').waitFor({ state: 'visible' });
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
  console.log('Docs search, keyboard tabs, clipboard, mobile navigation, OpenAPI download, Render reference and Markdown passed.');
} finally {
  await browser.close();
}
