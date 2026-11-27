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
export type EstimateRequest = Schemas['EstimateRequest'];
export type Estimate = Schemas['Estimate'];
export type ServiceStatus = Schemas['ServiceStatus'];
export type Prices = Schemas['Prices'];
export type Attempt = Schemas['Attempt'];
export type CaptureSettings = Schemas['CaptureSettings'];
export type NetworkSummary = Schemas['NetworkSummary'];
export type NetworkList = Schemas['NetworkList'];
export type NetworkCallRow = Schemas['NetworkCallRow'];
export type NetworkCall = Schemas['NetworkCall'];
export type Me = Schemas['Me'];
export type KeyLimit = Schemas['KeyLimit'];
export type FeedbackRequest = Schemas['FeedbackRequest'];
export type Feedback = Schemas['Feedback'];
export type Login = Schemas['Login'];
export type LoginList = Schemas['LoginList'];
export type LoginInput = Schemas['LoginInput'];
export type LoginUpdate = Schemas['LoginUpdate'];
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
  requestId?: string | null;
  response?: unknown;
}

export class FetchXError extends Error {
  constructor(code: string, options?: FetchXErrorOptions);
  readonly code: string;
  readonly status: number | null;
  readonly details?: unknown;
  readonly retryAfterSeconds: number | null;
  readonly idempotencyKey: string | null;
  /** FetchX's id for the call (req_..., also the X-Request-Id header): quote it when asking about one. */
  readonly requestId: string | null;
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

export interface NetworkQuery {
  type?: 'document' | 'xhr' | 'fetch' | 'script' | 'eventsource' | 'other';
  content_type?: string;
  host?: string;
  first_party?: boolean;
  status?: string | number;
  page?: number;
  phase?: 'warmup' | 'load' | 'scroll' | 'replay';
  /** Values the response body holds, compared without case: one or up to 5. */
  contains?: string | string[];
  limit?: number;
  cursor?: string;
}

export interface UsageQuery {
  period?: 'day' | 'month';
  since?: string;
  until?: string;
  /** Only requests made with this API key (and the keys it was rotated from or to). */
  key_id?: string;
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
  /** The calls a request made with capture recorded, filtered; contains finds the call that carries the data. */
  network(id: string, query?: NetworkQuery): Promise<NetworkList>;
  networkCall(id: string, index: number | string): Promise<NetworkCall>;
  networkBody(id: string, index: number | string): Promise<Download>;
  /** The capture as a HAR 1.2 document, for browser developer tools. */
  networkHar(id: string, options?: {page?: number}): Promise<{log: Record<string, unknown>}>;
  /** Many URLs in one job, run at each site's pace; resolves with the batch at once. */
  submitBatch(input: BatchRequest): Promise<Batch>;
  getBatch(id: string): Promise<Batch>;
  listBatches(query?: BatchListQuery): Promise<BatchList>;
  batchItems(id: string, query?: BatchItemsQuery): Promise<BatchItemList>;
  cancelBatch(id: string): Promise<Batch>;
  /** Each item once it has finished, as items finish, until the batch is over. */
  batchResults(id: string, options?: {intervalMs?: number; limit?: number; results?: boolean}): AsyncGenerator<BatchItem, void, undefined>;
  /** What a request, or a batch ({items, defaults}), would cost and take. Nothing is sent or reserved. */
  estimate(input: EstimateRequest): Promise<Estimate>;
  /** Service status and notices. */
  status(): Promise<ServiceStatus>;
  /** What each step, a captcha, residential traffic and extraction cost in credits, and the trial credits a new account gets. */
  prices(): Promise<Prices>;
  balance(): Promise<Balance>;
  /** The project and key making the call, the key's scopes and its credit limits. Any valid key may call it. */
  me(): Promise<Me>;
  /** Report how FetchX handled a page: a request (fetch_id) or a URL, what you saw (kind), and evidence. Free. */
  sendFeedback(input: FeedbackRequest): Promise<Feedback>;
  /** Where a report stands and FetchX staff's reply. */
  getFeedback(id: string): Promise<Feedback>;
  /** Save a site login: FetchX signs in with it when a page on that site asks. The password is never returned. */
  saveLogin(input: LoginInput): Promise<Login>;
  /** The project's saved logins, usernames masked. */
  listLogins(): Promise<LoginList>;
  getLogin(id: string): Promise<Login>;
  /** Change a saved login. A new site, username or password starts over (status new, session dropped). */
  updateLogin(id: string, changes: LoginUpdate): Promise<Login>;
  /** Delete a saved login and its signed-in session. */
  deleteLogin(id: string): Promise<void>;
  usage(query?: UsageQuery): Promise<Usage>;
}
