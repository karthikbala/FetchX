import type {paths} from './openapi.js';

type JsonRequest<T extends {requestBody: {content: {'application/json': unknown}}}> =
  T['requestBody']['content']['application/json'];
type JsonSuccess<T extends {responses: {200: {content: {'application/json': unknown}}}}> =
  T['responses'][200]['content']['application/json'];

export type FetchRequest = JsonRequest<paths['/v2/fetch']['post']>;
export type FetchResponse = JsonSuccess<paths['/v2/fetch']['post']>;
export type RenderRequest = JsonRequest<paths['/v2/render']['post']>;
export type RenderResponse = JsonSuccess<paths['/v2/render']['post']>;
export type RenderPreparationRequest = JsonRequest<paths['/v2/render/prepare']['post']>;
export type RenderPreparation = JsonSuccess<paths['/v2/render/prepare']['post']>;
export type ScrapeRequest = JsonRequest<paths['/v2/scrape']['post']>;
export type ScrapeResponse = JsonSuccess<paths['/v2/scrape']['post']>;

type GatewayRecord = Record<string, unknown>;
type IdempotentRequest = GatewayRecord & {idempotency_key: string};
type FetchTransport = (url: string, options: RequestInit) => Promise<Response>;

export interface GatewayErrorOptions {
  status?: number | null;
  details?: unknown;
  workflow?: string | null;
  idempotency_key?: string | null;
  response?: GatewayRecord | null;
}

export class GatewayError extends Error {
  constructor(code: string, options?: GatewayErrorOptions);
  code: string;
  status: number | null;
  details?: unknown;
  workflow: string | null;
  idempotency_key: string | null;
  response: GatewayRecord | null;
  operation_id: string | null;
  session_id: string | null;
  retry: GatewayRecord | null;
  diagnostics: GatewayRecord | null;
}

export interface GatewayClientOptions {
  url: string;
  token: string;
  fetch?: FetchTransport;
}

export class GatewayClient {
  constructor(options: GatewayClientOptions);
  url: string;
  token: string;
  fetch: FetchTransport;
  call(path: string, body?: unknown, context?: GatewayErrorOptions, options?: {headers?: Record<string, string>}): Promise<GatewayRecord>;

  fetchV2(input: FetchRequest): Promise<FetchResponse>;
  lookupFetchV2(key: string): Promise<JsonSuccess<paths['/v2/fetch/{key}']['get']>>;
  readFetchOperationV2(id: string): Promise<JsonSuccess<paths['/v2/fetch/operations/{id}']['get']>>;
  renderV2(input: RenderRequest): Promise<RenderResponse>;
  prepareRenderV2(input: RenderPreparationRequest): Promise<RenderPreparation>;
  scrapeV2(input: ScrapeRequest, idempotencyKey: string): Promise<ScrapeResponse>;
  lookupRenderV2(key: string): Promise<JsonSuccess<paths['/v2/render/{key}']['get']>>;
  capabilitiesV2(): Promise<JsonSuccess<paths['/v2/capabilities']['get']>>;
  accessProfilesV2(): Promise<JsonSuccess<paths['/v2/access-profiles']['get']>>;
  recipesV2(): Promise<JsonSuccess<paths['/v2/recipes']['get']>>;
  readOperationV2(id: string): Promise<JsonSuccess<paths['/v2/operations/{id}']['get']>>;
  lookupOperationV2(key: string): Promise<JsonSuccess<paths['/v2/operations/by-key/{key}']['get']>>;
  artifactV2(id: string): Promise<JsonSuccess<paths['/v2/artifacts/{id}']['get']>>;
  usageV2(): Promise<JsonSuccess<paths['/v2/usage']['get']>>;
  recentOperationsV2(limit?: number): Promise<JsonSuccess<paths['/v2/operations']['get']>>;

  discoveryProfileV2(input: IdempotentRequest): Promise<GatewayRecord>;
  sessionV2(input: IdempotentRequest): Promise<GatewayRecord>;
  readSessionV2(id: string): Promise<GatewayRecord>;
  operationV2(input: IdempotentRequest): Promise<GatewayRecord>;
  browserProbeV2(input: IdempotentRequest): Promise<GatewayRecord>;

  workflow(profile: string, key?: string, limits?: GatewayRecord): Promise<GatewayRecord>;
  request(workflow: string, input: GatewayRecord): Promise<GatewayRecord>;
  lookup(workflow: string, key: string): Promise<GatewayRecord>;
  close(workflow: string): Promise<GatewayRecord>;
  fetchPage(input: IdempotentRequest): Promise<GatewayRecord>;
  lookupFetch(key: string): Promise<GatewayRecord>;
  submitJob(input: IdempotentRequest): Promise<GatewayRecord>;
  job(id: string): Promise<GatewayRecord>;
  profiles(): Promise<GatewayRecord>;
  status(): Promise<GatewayRecord>;
  diagnostics(operation: string): Promise<GatewayRecord>;
  outcome(operation: string, input: {accepted_records: number; rejected_records: number; reason_code: string}): Promise<GatewayRecord>;
}

export {GatewayClient as FetchXClient};
