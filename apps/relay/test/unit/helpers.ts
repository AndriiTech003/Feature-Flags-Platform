import { loadRelayConfig } from '../../src/config';
import { createRelay, type RunningRelay } from '../../src/app';
import type { RelayConfig } from '../../src/config';
import { MemorySource } from '../../src/source';

export async function memoryRelay(
  heartbeatMs = 15000,
  overrides: Partial<RelayConfig> = {},
): Promise<{ relay: RunningRelay; source: MemorySource }> {
  const source = new MemorySource();
  const defaults = loadRelayConfig({});
  const relay = await createRelay(
    {
      ...defaults,
      port: 0,
      heartbeatMs,
      versionCheckMs: 60000,
      rateLimit: { ...defaults.rateLimit, enabled: false },
      ...overrides,
    },
    { source, redis: false },
  );
  return { relay, source };
}

export async function readSse(
  url: string,
  init: RequestInit,
  until: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(url, { ...init, signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (!until(text)) {
      if (Date.now() > deadline)
        throw new Error(`timeout waiting for SSE content, got: ${text.slice(0, 500)}`);
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
        ),
      ]);
      if (result.done) continue;
      text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    controller.abort();
  }
  return text;
}

export function sseEvents(text: string): Array<{ event: string; data: any }> {
  return text
    .split('\n\n')
    .filter((block) => block.includes('data:'))
    .map((block) => {
      const event = /event: (.*)/.exec(block)?.[1] ?? 'message';
      const data = JSON.parse(
        block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n'),
      );
      return { event, data };
    });
}
