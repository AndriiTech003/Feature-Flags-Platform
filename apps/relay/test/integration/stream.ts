import { expect } from 'vitest';

export interface StreamReader {
  events: Array<{ event: string; data: any; at: number }>;
  close(): void;
  waitFor(
    predicate: (e: { event: string; data: any }) => boolean,
    timeoutMs?: number,
  ): Promise<{ event: string; data: any; at: number }>;
}

export async function openStream(baseUrl: string, path: string, key: string): Promise<StreamReader> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: key },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: StreamReader['events'] = [];
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (event && data) events.push({ event, data: JSON.parse(data), at: performance.now() });
        }
      }
    } catch {
      return;
    }
  })();
  return {
    events,
    close: () => controller.abort(),
    waitFor: async (predicate, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline)
          throw new Error(`no matching event, got ${JSON.stringify(events.map((e) => e.event))}`);
        await new Promise((r) => setTimeout(r, 2));
      }
    },
  };
}
