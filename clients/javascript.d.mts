import type {components} from './openapi.js';

type Schemas = components['schemas'];
export type FetchRequest = Schemas['FetchRequest'];
export type NextPageRequest = Schemas['NextPageRequest'];
export type NextPage = Schemas['NextPage'];
export type FetchResult = Schemas['FetchResult'];
export type FetchData = Schemas['FetchData'];
export type FetchList = Schemas['FetchList'];
export type Usage = Schemas['Usage'];
export type Balance = Schemas['Balance'];
export type Attempt = Schemas['Attempt'];
// The batch owns async, webhook_url and idempotency_key; the API refuses them on items and defaults.
type BatchOwned = 'async' | 'webhook_url' | 'idempotency_key';
export type BatchItemRequest = Omit<FetchRequest, BatchOwned>;
export type BatchDefaults = Partial<Omit<FetchRequest, BatchOwned | 'url'>>;
export type BatchRequest = Omit<Schemas['BatchRequest'], 'items' | 'defaults'> & {
  items: (string | BatchItemRequest)[];
  defaults?: BatchDefaults;
};
export type Batch = Schemas['Batch'];
export type BatchList = Schemas['BatchList'];
export type BatchItem = Schemas['BatchItem'];
export type BatchItemList = Schemas['BatchItemList'];

type Transport = (url: string, options: RequestInit) => Promise<Response>;

export interface FetchXClientOptions {
  url: string;
  token: string;
  fetch?: Transport;
  timeoutMs?: number;
  /** How many times a lost, rate-limited or unavailable POST is resent with the same idempotency_key. */
  retries?: number;
}

export interface FetchXErrorOptions {
  status?: number | null;
  details?: unknown;
  retryAfterSeconds?: number | null;
  idempotencyKey?: string | null;
  response?: unknown;
}

export class FetchXError extends Error {
  constructor(code: string, options?: FetchXErrorOptions);
  readonly code: string;
  readonly status: number | null;
  readonly details?: unknown;
  readonly retryAfterSeconds: number | null;
  readonly idempotencyKey: string | null;
  readonly response: unknown;
}

export interface ListQuery {
  status?: 'pending' | 'succeeded' | 'failed';
  tag?: string;
  idempotency_key?: string;
  since?: string;
  limit?: number;
  cursor?: string;
}

export interface BatchListQuery {
  status?: 'running' | 'paused' | 'finished' | 'canceled';
  limit?: number;
  cursor?: string;
}

export interface BatchItemsQuery {
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  order?: 'index' | 'finished';
  results?: boolean;
  limit?: number;
  cursor?: string;
}

export interface UsageQuery {
  period?: 'day' | 'month';
  since?: string;
  until?: string;
}

export interface Download {
  body: Uint8Array;
  contentType: string | null;
}

export class FetchXClient {
  constructor(options: FetchXClientOptions);
  fetch(input: FetchRequest): Promise<FetchResult>;
  /** The page after a result whose data.next_page is set: a new request, billed only when it succeeds. */
  nextPage(id: string, input?: NextPageRequest): Promise<FetchResult>;
  get(id: string, options?: {includeBody?: boolean}): Promise<FetchResult>;
  wait(id: string, options?: {intervalMs?: number; timeoutMs?: number; includeBody?: boolean}): Promise<FetchResult>;
  list(query?: ListQuery): Promise<FetchList>;
  content(id: string): Promise<Download>;
  screenshot(id: string): Promise<Download>;
  delete(id: string): Promise<void>;
  /** Many URLs in one job, run at each site's pace; resolves with the batch at once. */
  submitBatch(input: BatchRequest): Promise<Batch>;
  getBatch(id: string): Promise<Batch>;
  listBatches(query?: BatchListQuery): Promise<BatchList>;
  batchItems(id: string, query?: BatchItemsQuery): Promise<BatchItemList>;
  cancelBatch(id: string): Promise<Batch>;
  /** Each item once it has finished, as items finish, until the batch is over. */
  batchResults(id: string, options?: {intervalMs?: number; limit?: number; results?: boolean}): AsyncGenerator<BatchItem, void, undefined>;
  balance(): Promise<Balance>;
  usage(query?: UsageQuery): Promise<Usage>;
}
