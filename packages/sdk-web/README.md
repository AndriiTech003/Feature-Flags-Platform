# @ashamrai/flags-web

Browser feature flags SDK, 3.1 KB gzip. The browser never downloads targeting rules: the relay evaluates flags for one context and streams the values.

## Install

```sh
npm i @ashamrai/flags-web
```

## Quick start

```ts
import { createClient } from '@ashamrai/flags-web';

const client = createClient({
  clientKey: 'cli-…',
  baseUrl: 'https://relay.example.dev',
  context: { kind: 'user', key: 'anon-123' },
  bootstrap: window.__FLAGS__, // from allFlagsState() on the server: no flicker
});

await client.ready();
client.variation('banner-text', 'Welcome');
await client.identify({ kind: 'user', key: user.id, plan: 'pro' }); // re-evaluated by the relay
client.on('change', (changes) => render(changes));
client.track('purchase', { value: 49.9 });
```

## Features

- SSE stream with re-evaluated values (`/sdk/v1/client-stream`), reconnect with backoff and jitter, heartbeat watchdog, `/sdk/v1/evaluate` fallback.
- Honours `Retry-After` on `429`/`503`: stream reconnects, evaluate calls and event flushes wait at least that long; throttled events stay queued and are sent later.
- Last values cached in `localStorage` per context hash: instant start on the next visit.
- `bootstrap` from SSR so the first render already has the right values.
- Events are flushed every 5 s and sent with `navigator.sendBeacon` when the page becomes hidden.

## Why exposure is counted when `variation()` is called

An experiment compares users who actually saw a variation. If exposures were recorded when values are loaded, every visitor of every page would enter every experiment, diluting the effect and making a sample ratio mismatch likely when some variations are rendered conditionally. Calling `variation()` is the moment the value influences the UI, so that is when the exposure is recorded (deduplicated per context, flag and variation).

## FAQ

**Can a user see other users' targeting?** No. Client keys only receive evaluated values for flags marked "available to client-side SDKs"; rules, segments and other flags never leave the server.

**Bundle size?** Checked by size-limit in CI: limit 5 KB gzip, current 3.1 KB.

MIT licensed.
