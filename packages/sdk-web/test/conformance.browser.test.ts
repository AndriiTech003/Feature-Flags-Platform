import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { registerConformanceSuite, type ConformanceAdapter } from '@ffp/conformance';
import { createClient, type Context, type WebClient } from '../src';

let client: WebClient | null = null;

const adapter: ConformanceAdapter = {
  name: 'sdk-web (real browser, evaluated by relay)',
  load(file) {
    client = createClient({
      clientKey: `cli-${file.name}`,
      baseUrl: inject('relayUrl'),
      context: { kind: 'user', key: 'bootstrap-only' },
      stream: false,
      withReasons: true,
      sendEvents: false,
      storage: null,
    });
  },
  async unload() {
    await client?.close();
  },
  async evaluate(testCase) {
    await client!.identify(testCase.context as Context);
    return client!.variationDetail(testCase.flagKey, testCase.default ?? null, testCase.expectedKind);
  },
};

describe('environment', () => {
  it('runs in a real browser', () => {
    expect(navigator.userAgent).toMatch(/Chrome|Firefox|Safari|AppleWebKit/);
  });
});

registerConformanceSuite(adapter, { describe, it, beforeAll, afterAll, expect });
