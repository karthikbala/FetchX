import {FetchXClient, GatewayError, type FetchRequest, type FetchResponse, type RenderResponse} from '../clients/javascript.mjs';

async function checkClientTypes() {
  const client = new FetchXClient({url: 'https://gateway.example', token: 'fixture-token'});
  const input = {
    idempotency_key: 'saved-fetch',
    access_profile: {id: 'example.http', version: 1},
    url: 'https://source.example/',
    proxy: {class: 'direct', country: null},
  } satisfies FetchRequest;

  const fetchResult: FetchResponse = await client.fetchV2(input);
  const sourceStatus: number | null | undefined = fetchResult.data?.status;
  const gatewayStatus: number = fetchResult.gateway_http_status;
  const recoveredFetch: FetchResponse = await client.lookupFetchV2(input.idempotency_key);
  if (recoveredFetch.operation_id) {
    const operation: FetchResponse = await client.readFetchOperationV2(recoveredFetch.operation_id);
    console.log(operation.retry.next_action);
  }

  const renderResult: RenderResponse = await client.renderV2({
    ...input,
    idempotency_key: 'saved-render',
    access_profile: {id: 'example.browser', version: 1},
    screenshot: true,
  });
  const recoveredRender: RenderResponse = await client.lookupRenderV2('saved-render');
  const execution: 'browser' = recoveredRender.execution;
  const renderAvailable: boolean = (await client.capabilitiesV2()).features.browser_render;
  console.log(sourceStatus, gatewayStatus, renderResult.success, execution, renderAvailable);

  const prepared = await client.prepareRenderV2({url: input.url, proxy: input.proxy});
  if (prepared.ready && prepared.access_profile && prepared.url) {
    await client.renderV2({idempotency_key: 'prepared-render', access_profile: prepared.access_profile, url: prepared.url, proxy: input.proxy});
  }
  const scraped = await client.scrapeV2({url: input.url, formats: ['markdown']}, 'saved-scrape');
  const markdown: string | undefined = scraped.data.markdown;
  const paid = await client.fetchV2({idempotency_key: 'paid-fetch', url: input.url, proxy: {class: 'datacenter', country: 'US'}, max_transfer_mb: 2.25, max_credits: 3});
  const debit: number | null | undefined = paid.usage?.accounting.paid_credits?.used_credits;
  console.log(markdown, debit);

  try {
    await client.fetchPage({profile: 'example.http', url: input.url, idempotency_key: 'v1-key'});
  } catch (error) {
    if (error instanceof GatewayError) {
      const key: string | null = error.idempotency_key;
      console.log(error.code, key, error.retry?.next_action, error.response);
    }
  }

  const {idempotency_key: savedKey, ...missingKey} = input;
  // @ts-expect-error New submissions require the caller's durable key.
  await client.fetchV2(missingKey);
  // @ts-expect-error Render accepts an approved GET navigation and no method option.
  await client.renderV2({...input, method: 'POST'});
  // @ts-expect-error Scrape submissions require the caller's durable key.
  await client.scrapeV2({url: input.url});
  // @ts-expect-error Direct proxy selection requires an explicit null country.
  await client.fetchV2({...input, proxy: {class: 'direct', country: 'US'}});
  await client.lookupOperationV2(savedKey);
}
