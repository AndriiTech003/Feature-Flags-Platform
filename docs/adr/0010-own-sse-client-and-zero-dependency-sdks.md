# ADR 0010: Zero-dependency SDKs with an own SSE client

- Status: accepted
- Date: 2026-10-01

## Context

SDKs are installed into other people's applications. Every dependency adds supply-chain risk, version conflicts and bundle size; `eventsource` polyfills cannot send an `Authorization` header and hide stalled connections.

## Decision

`@ashamrai/flags-evaluator` has no dependencies; `@ashamrai/flags-node` depends only on the evaluator; `@ashamrai/flags-web` depends on nothing. The SSE client, backoff, LRU dedupe, event processor and emitter are written in the SDKs. Builds are `tsup` ESM + CJS + `.d.ts` with `exports` conditions, checked by `publint` and `@arethetypeswrong/cli`, sizes enforced by `size-limit` (web SDK limit 5 KB gzip, current 3.1 KB).

## Consequences

- More code to own and test: SSE parsing (CRLF, multi-line data, comments), heartbeat watchdog and reconnects are covered by unit tests and by resilience tests against a fake relay (relay down at start, dies mid-stream, malformed stream, slow relay, heartbeat timeout).
- The Node SDK requires Node 20+ (`fetch`, `ReadableStream`, `AbortSignal.timeout`).
- `@ashamrai/flags-node` emits its own events instead of extending Node's `EventEmitter`, so an `error` event without a listener can never crash the process.
