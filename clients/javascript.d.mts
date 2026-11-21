import type {components} from './openapi.js';

type Schemas = components['schemas'];
export type FetchRequest = Schemas['FetchRequest'];
export type FetchResult = Schemas['FetchResult'];
export type FetchData = Schemas['FetchData'];
export type FetchList = Schemas['FetchList'];
export type Usage = Schemas['Usage'];
export type Balance = Schemas['Balance'];
export type Attempt = Schemas['Attempt'];

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
  get(id: string, options?: {includeBody?: boolean}): Promise<FetchResult>;
  wait(id: string, options?: {intervalMs?: number; timeoutMs?: number; includeBody?: boolean}): Promise<FetchResult>;
  list(query?: ListQuery): Promise<FetchList>;
  content(id: string): Promise<Download>;
  screenshot(id: string): Promise<Download>;
  delete(id: string): Promise<void>;
  balance(): Promise<Balance>;
  usage(query?: UsageQuery): Promise<Usage>;
}
