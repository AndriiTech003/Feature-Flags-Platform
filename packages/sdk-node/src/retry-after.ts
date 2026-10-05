export const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(Number(trimmed) * 1000));
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now));
}

export function isThrottled(status: number): boolean {
  return status === 429 || status === 503;
}

export class RetryGate {
  private until = 0;
  throttled = 0;

  constructor(private readonly now: () => number = Date.now) {}

  note(response: Pick<Response, 'status' | 'headers'>, fallbackMs = 1000): number {
    if (!isThrottled(response.status)) return 0;
    const wait = parseRetryAfter(response.headers.get('retry-after'), this.now()) ?? fallbackMs;
    this.until = Math.max(this.until, this.now() + wait);
    this.throttled++;
    return wait;
  }

  remaining(): number {
    return Math.max(0, this.until - this.now());
  }
}
