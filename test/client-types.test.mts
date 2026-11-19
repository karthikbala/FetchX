import {FetchXClient, FetchXError, type FetchRequest, type FetchResult, type Usage} from '../clients/javascript.mjs';

async function checkClientTypes() {
  const client = new FetchXClient({url: 'https://app.fetchx.ai', token: 'fxk_fixture'});
  const input = {url: 'https://shop.example.com/', formats: ['markdown', 'metadata'], render: 'auto', max_credits: 60,
    route: {class: 'residential', country: 'US'}} satisfies FetchRequest;
  const result: FetchResult = await client.fetch(input);
  const status: 'pending' | 'succeeded' | 'failed' = result.status;
  const markdown: string | undefined = result.data?.markdown;
  const charged: number = result.credits.charged;
  const next: string | undefined = result.error?.next.action;
  const finished: FetchResult = await client.wait(result.id, {intervalMs: 1000});
  const page = await client.list({status: 'failed', limit: 10});
  const cursor: string | null = page.next_cursor;
  const usage: Usage = await client.usage({period: 'day'});
  const download = await client.content(result.id);
  const bytes: Uint8Array = download.body;
  await client.delete(result.id);
  try {
    await client.fetch({url: 'https://shop.example.com/', max_attempts: 3});
  } catch (error) {
    if (error instanceof FetchXError) console.log(error.code, error.status, error.retryAfterSeconds, error.idempotencyKey);
  }
  console.log(status, markdown, charged, next, finished.status, cursor, usage.balance?.credits, bytes.length);
}

// @ts-expect-error: url is required.
const missingUrl: FetchRequest = {formats: ['markdown']};
// @ts-expect-error: only documented formats are accepted.
const badFormat: FetchRequest = {url: 'https://shop.example.com/', formats: ['pdf']};
void checkClientTypes;
void missingUrl;
void badFormat;
