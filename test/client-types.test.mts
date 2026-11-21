import {FetchXClient, FetchXError, type FetchRequest, type FetchResult, type Usage, type Balance} from '../clients/javascript.mjs';

async function checkClientTypes() {
  const client = new FetchXClient({url: 'https://app.fetchx.ai', token: 'fxk_fixture'});
  const input = {url: 'https://shop.example.com/', formats: ['markdown', 'metadata'], render: 'auto', max_credits: 60,
    route: {class: 'residential', country: 'US'}, block_resources: true,
    expect: {selector: '.price', text: 'Add to cart', min_markdown_length: 200}} satisfies FetchRequest;
  const result: FetchResult = await client.fetch(input);
  const status: 'pending' | 'succeeded' | 'failed' = result.status;
  const markdown: string | undefined = result.data?.markdown;
  const charged: number = result.credits.charged;
  const next: string | undefined = result.error?.next.action;
  const finished: FetchResult = await client.wait(result.id, {intervalMs: 1000});
  const how: 'link' | 'click' | 'scroll' | undefined = result.data?.next_page?.how;
  const second: FetchResult = await client.nextPage(result.id, {scroll: 20, max_credits: 60});
  const pageNumber: number | undefined = second.data?.page?.number;
  await client.fetch({url: 'https://shop.example.com/', scroll: 'off'});
  const page = await client.list({status: 'failed', limit: 10});
  const cursor: string | null = page.next_cursor;
  const usage: Usage = await client.usage({period: 'day'});
  const balance: Balance = await client.balance();
  const available: number | null = balance.credits;
  const pageStatus: string | null | undefined = result.page_status;
  const traffic: number | undefined = result.credits.breakdown?.traffic_credits;
  const download = await client.content(result.id);
  const bytes: Uint8Array = download.body;
  await client.delete(result.id);
  try {
    await client.fetch({url: 'https://shop.example.com/', max_attempts: 3});
  } catch (error) {
    if (error instanceof FetchXError) console.log(error.code, error.status, error.retryAfterSeconds, error.idempotencyKey);
  }
  console.log(status, markdown, charged, next, finished.status, cursor, usage.balance?.credits, available, pageStatus, traffic, bytes.length, how, pageNumber);
}

// @ts-expect-error: url is required.
const missingUrl: FetchRequest = {formats: ['markdown']};
// @ts-expect-error: scroll is auto, off or a number of screens.
const badScroll: FetchRequest = {url: 'https://shop.example.com/', scroll: 'all'};
// @ts-expect-error: only documented formats are accepted.
const badFormat: FetchRequest = {url: 'https://shop.example.com/', formats: ['pdf']};
void checkClientTypes;
void missingUrl;
void badFormat;
void badScroll;
