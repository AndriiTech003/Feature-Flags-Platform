export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

import type { RetryGate } from './retry-after';

export interface SseOptions {
  url: string;
  gate?: RetryGate;
  headers: Record<string, string>;
  fetch: typeof fetch;
  initialRetryMs: number;
  maxRetryMs: number;
  heartbeatTimeoutMs: number;
  onOpen(): void;
  onMessage(message: SseMessage): void;
  onError(error: Error, willRetryInMs: number): void;
  random?: () => number;
}

export function backoffDelay(
  attempt: number,
  initialMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt - 1));
  const jitter = base / 2;
  return Math.round(base - jitter + random() * jitter);
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  constructor(private readonly onMessage: (message: SseMessage) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, index);
      const newlineLength = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(index + newlineLength);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) {
        const message: SseMessage = { event: this.event || 'message', data: this.data.join('\n') };
        if (this.id !== undefined) message.id = this.id;
        this.onMessage(message);
      }
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
  }
}

export class SseClient {
  private controller: AbortController | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  reconnects = 0;

  constructor(private readonly options: SseOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearWatchdog();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.controller?.abort();
    this.controller = null;
  }

  fail(error: Error): void {
    this.controller?.abort(error);
  }

  resetBackoff(): void {
    this.attempt = 0;
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private armWatchdog(controller: AbortController): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(
      () => controller.abort(new Error('heartbeat timeout')),
      this.options.heartbeatTimeoutMs,
    );
    const timer = this.watchdog as { unref?: () => void };
    timer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    let failure: Error;
    try {
      this.armWatchdog(controller);
      const response = await this.options.fetch(this.options.url, {
        headers: { accept: 'text/event-stream', ...this.options.headers },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const wait = this.options.gate?.note(response) ?? 0;
        throw new Error(
          `stream responded with ${response.status}${wait > 0 ? `, retry after ${wait} ms` : ''}`,
        );
      }
      this.options.onOpen();
      const parser = new SseParser((message) => this.options.onMessage(message));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.armWatchdog(controller);
        parser.push(decoder.decode(value, { stream: true }));
      }
      failure = new Error('stream closed by server');
    } catch (error) {
      const reason = controller.signal.reason;
      failure = reason instanceof Error ? reason : error instanceof Error ? error : new Error(String(error));
    } finally {
      this.clearWatchdog();
    }
    if (this.stopped) return;
    this.attempt++;
    this.reconnects++;
    const delay = Math.max(
      backoffDelay(this.attempt, this.options.initialRetryMs, this.options.maxRetryMs, this.options.random),
      this.options.gate?.remaining() ?? 0,
    );
    this.options.onError(failure, delay);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }
}
