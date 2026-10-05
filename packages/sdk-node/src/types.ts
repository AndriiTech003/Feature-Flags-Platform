import type {
  Context,
  EvaluationReason,
  FlagState,
  FlagWithConfig,
  Ruleset,
  Segment,
} from '@ashamrai/flags-evaluator';

export type { Context, EvaluationReason, FlagState, FlagWithConfig, Ruleset, Segment };

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface PersistentStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface EventOptions {
  enabled?: boolean;
  flushIntervalMs?: number;
  capacity?: number;
  exposureDedupTtlMs?: number;
  exposureDedupCapacity?: number;
}

export interface FlagsOptions {
  sdkKey: string;
  baseUrl?: string;
  stream?: boolean;
  pollIntervalMs?: number;
  events?: EventOptions;
  bootstrap?: Ruleset;
  logger?: Logger;
  persistentStore?: PersistentStore;
  offline?: boolean;
  diagnostics?: { enabled?: boolean; intervalMs?: number };
  streamInitialRetryMs?: number;
  streamMaxRetryMs?: number;
  heartbeatTimeoutMs?: number;
  requestTimeoutMs?: number;
  throwOnInvalidConfig?: boolean;
  fetch?: typeof fetch;
}

export type DataSourceKind = 'stream' | 'polling' | 'bootstrap' | 'persistent' | 'offline' | 'none';

export interface InitializationResult {
  initialized: boolean;
  source: DataSourceKind;
  timedOut: boolean;
  error?: string;
}

export type SdkReason = EvaluationReason | { kind: 'ERROR'; errorKind: 'CLIENT_NOT_READY' };

export interface FlagDetail<T> {
  value: T;
  variationId: string | null;
  reason: SdkReason;
}

export interface AllFlagsState {
  valid: boolean;
  flags: Record<string, FlagState>;
  toJSON(): { valid: boolean; flags: Record<string, FlagState> };
}

export interface ClientEvents {
  ready: { source: DataSourceKind };
  update: { key: string; kind: 'flag' | 'segment' | 'all'; version: number };
  error: Error;
  stale: { reason: string };
}

export interface FlagTypes {}

export type KnownFlagKey = keyof FlagTypes & string;
