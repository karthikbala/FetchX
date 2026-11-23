import {FetchXClient, FetchXError, type FetchRequest, type FetchResult, type Usage, type Balance, type Batch, type BatchItem,
  type BatchRequest, type NetworkList, type NetworkCall, type Me, type Feedback} from '../clients/javascript.mjs';

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
  const captured: FetchResult = await client.fetch({url: 'https://shop.example.com/', capture: {types: ['document', 'xhr', 'fetch'], max_requests: 50}});
  const calls: number | undefined = captured.network?.captured;
  const rows: NetworkList = await client.network(captured.id, {contains: ['Lamp', '19.99'], first_party: true, phase: 'scroll'});
  const call: NetworkCall = await client.networkCall(captured.id, rows.items[0].index);
  const callBody: string | null | undefined = call.response?.body;
  const har = await client.networkHar(captured.id);
  const shaped = await client.fetch({url: 'https://shop.example.com/api/items', render: 'never', formats: ['skeleton']});
  const firstPath: string | undefined = shaped.data?.skeleton?.fields[0]?.path;
  const arrayItems: number | undefined = shaped.data?.skeleton?.fields.find(row => row.type === 'array')?.items;
  console.log(firstPath, arrayItems);
  const me: Me = await client.me();
  const scopes: string[] = me.scopes;
  const monthLeft: number | undefined = me.limits.credits_per_month?.remaining;
  const expires: string | null = me.limits.expires_at;
  console.log(monthLeft, expires);
  const report: Feedback = await client.sendFeedback({fetch_id: captured.id, kind: 'blocked_via_fetchx_ok_from_home',
    evidence: {status_code: 200, client: 'curl from a home connection'}});
  const reply: string | null = (await client.getFeedback(report.id)).reply;
  const state: 'received' | 'reviewing' | 'resolved' | 'dismissed' = report.status;
  // @ts-expect-error kind is one of the documented values
  await client.sendFeedback({url: 'https://shop.example.com/', kind: 'slow'});
  console.log(reply, state);
  console.log(calls, callBody, har.log, scopes, (await client.networkBody(captured.id, 1)).contentType);
  const batchInput = {items: ['https://shop.example.com/a', {url: 'https://shop.example.com/b', formats: ['text']}],
    defaults: {formats: ['markdown'], render: 'auto'}, webhook_url: 'https://hooks.example.com/fetchx', tags: ['nightly']} satisfies BatchRequest;
  const batch: Batch = await client.submitBatch(batchInput);
  const batchStatus: 'running' | 'paused' | 'finished' | 'canceled' = batch.status;
  const queued: number = batch.items.queued;
  const items = await client.batchItems(batch.id, {order: 'finished', status: 'succeeded', results: false, limit: 50});
  for await (const item of client.batchResults(batch.id, {intervalMs: 2000})) {
    const done: BatchItem = item;
    console.log(done.index, done.result?.data?.markdown, done.result?.batch?.index);
  }
  await client.cancelBatch((await client.listBatches({status: 'paused'})).items[0].id);
  try {
    await client.fetch({url: 'https://shop.example.com/', max_attempts: 3});
  } catch (error) {
    if (error instanceof FetchXError) console.log(error.code, error.status, error.retryAfterSeconds, error.idempotencyKey);
  }
  console.log(status, markdown, charged, next, finished.status, cursor, usage.balance?.credits, available, pageStatus, traffic, bytes.length, how, pageNumber,
    batchStatus, queued, items.next_cursor);
}

// @ts-expect-error: url is required.
const missingUrl: FetchRequest = {formats: ['markdown']};
// @ts-expect-error: scroll is auto, off or a number of screens.
const badScroll: FetchRequest = {url: 'https://shop.example.com/', scroll: 'all'};
// @ts-expect-error: only documented formats are accepted.
const badFormat: FetchRequest = {url: 'https://shop.example.com/', formats: ['pdf']};
// @ts-expect-error: a batch's items are owned by the batch: no async or webhook of their own.
const ownWebhook: BatchRequest = {items: [{url: 'https://shop.example.com/', webhook_url: 'https://hooks.example.com/'}]};
// @ts-expect-error: defaults never carry a url; each item has its own.
const defaultUrl: BatchRequest = {items: ['https://shop.example.com/'], defaults: {url: 'https://shop.example.com/'}};
// @ts-expect-error: capture types are the documented ones.
const badCapture: FetchRequest = {url: 'https://shop.example.com/', capture: {types: ['image']}};
void checkClientTypes;
void ownWebhook;
void defaultUrl;
void missingUrl;
void badFormat;
void badScroll;
