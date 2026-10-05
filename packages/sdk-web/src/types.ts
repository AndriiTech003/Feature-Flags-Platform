export type Context = { kind?: string; key?: string; [attribute: string]: unknown };

export type Reason = { kind: string; [field: string]: unknown };

export interface FlagValue {
  value: unknown;
  variationId: string | null;
  version?: number;
  reason?: Reason;
  inExperiment?: boolean;
}

export type FlagValues = Record<string, FlagValue>;

export interface Detail<T> {
  value: T;
  variationId: string | null;
  reason: Reason;
}

export interface Logger {
  warn(message: string): void;
  error(message: string): void;
}

export interface WebClientOptions {
  clientKey: string;
  context: Context;
  baseUrl?: string;
  bootstrap?: FlagValues | { flags: FlagValues };
  stream?: boolean;
  withReasons?: boolean;
  sendEvents?: boolean;
  flushIntervalMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  fetch?: typeof fetch;
  logger?: Logger;
  streamInitialRetryMs?: number;
  streamMaxRetryMs?: number;
  heartbeatTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface Change {
  current: unknown;
  previous: unknown;
}

export interface WebClientEvents {
  ready: void;
  change: Record<string, Change>;
  error: Error;
}

export type ExpectedKind = 'boolean' | 'string' | 'number' | 'json';

export interface WebFlagTypes {}
