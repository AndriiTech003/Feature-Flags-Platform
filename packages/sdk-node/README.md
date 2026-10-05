# @ashamrai/flags-node

Server-side feature flags SDK for Node.js 20+. Rules are downloaded once and streamed over SSE; every `variation()` call is evaluated locally in microseconds with zero network calls.

## Install

```sh
npm i @ashamrai/flags-node
```

## Quick start

```ts
import { init } from '@ashamrai/flags-node';

const flags = init({ sdkKey: process.env.FLAGS_SDK_KEY!, baseUrl: 'https://relay.example.dev' });
await flags.waitForInitialization({ timeoutMs: 3000 }); // never throws, returns { initialized, source }

const ctx = { kind: 'user', key: user.id, plan: user.plan };
if (flags.boolVariation('new-checkout', ctx, false)) renderNewCheckout();
const detail = flags.boolVariationDetail('new-checkout', ctx, false); // { value, variationId, reason }
flags.track('purchase', ctx, { value: 49.9 });
flags.on('update', ({ key }) => console.log(`${key} changed`));
await flags.close(); // flushes events
```

## Options

| Option            | Default                                      |                                                                                             |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `sdkKey`          | required                                     | Server key (`srv-…`).                                                                       |
| `baseUrl`         | hosted demo relay                            | Relay URL.                                                                                  |
| `stream`          | `true`                                       | SSE streaming; `false` polls `/sdk/v1/ruleset` with `If-None-Match`.                        |
| `pollIntervalMs`  | `30000`                                      | Polling interval and fallback while the stream is down.                                     |
| `events`          | `{ flushIntervalMs: 5000, capacity: 10000 }` | Event buffer; oldest events are dropped and counted when full.                              |
| `bootstrap`       | —                                            | Ruleset to start from (offline mode, tests).                                                |
| `persistentStore` | —                                            | `{ get, set }` to keep the last ruleset across restarts (see `@ashamrai/flags-node-redis`). |
| `logger`          | console                                      | `{ debug, info, warn, error }`, e.g. pino.                                                  |
| `offline`         | `false`                                      | No network at all, only `bootstrap`.                                                        |

## Behaviour

- **Never breaks the app.** Any error becomes the default value plus a log line and an `error` event. Only `throwOnInvalidConfig: true` makes `init` throw.
- **Streaming.** Own SSE client over `fetch` + `ReadableStream`: `put`/`patch` events, reconnect with exponential backoff 1 s → 30 s with jitter, reconnect when no bytes (heartbeats included) arrive for 45 s, polling with ETag while the stream is down. A `429` or `503` with `Retry-After` (seconds or HTTP date, capped at 10 minutes) delays the next stream connect and poll until then.
- **Events.** Exposures are deduplicated per context + flag + variation for one hour (LRU), evaluation counts are summarized per flush, custom events from `track()`; one retry; flushed on `close()` and `beforeExit`. A throttled batch (`429`/`503`) is kept in the queue and resent after `Retry-After` instead of being dropped.
- **Diagnostics** every 15 minutes: init time, reconnects, queue size, dropped events.
- **Typed flags.** Run `npx @ashamrai/flags-cli codegen` to get `flags.variation('new-checkout', ctx, false)` typed as `boolean`.
- **SSR.** `allFlagsState(ctx, { clientSideOnly: true })` produces the bootstrap for `@ashamrai/flags-web`.

## FAQ

**What happens if the relay is down at startup?** `waitForInitialization` resolves with `initialized: false`, evaluations return defaults (reason `CLIENT_NOT_READY`) or the persisted ruleset, and the SDK keeps reconnecting in the background.

**How fast is it?** About 0.4 µs for a flag with 5 rules (Apple M1); a heap test runs 1 M evaluations and 1000 patches with stable memory.

MIT licensed.
