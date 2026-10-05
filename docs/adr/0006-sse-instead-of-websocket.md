# ADR 0006: Server-Sent Events instead of WebSocket for flag updates

- Status: accepted
- Date: 2026-10-01

## Context

SDKs need to learn about flag changes within a second. Traffic is one-directional: server to SDK. Events from SDKs are batched and can use plain HTTP POST.

## Decision

The relay exposes `text/event-stream` endpoints: `put` with the full state on connect, `patch` per changed flag or segment, and a `:heartbeat` comment every 15 seconds. SDKs implement their own SSE parser over `fetch` + `ReadableStream`, reconnect with exponential backoff (1 s → 30 s, jitter), treat 45 s without bytes as a dead connection, and fall back to polling `/sdk/v1/ruleset` with `If-None-Match` while disconnected.

## Consequences

- Works through standard HTTP infrastructure (proxies, load balancers, HTTP/2 multiplexing) without an upgrade handshake; easy to debug with `curl -N`.
- Using `fetch` instead of `EventSource` allows an `Authorization` header and lets the SDK detect stalled connections; the browser SDK stays dependency-free.
- One long-lived connection per SDK instance (server) or per tab (browser). Measured 3000 concurrent streams on one relay process at 147 MB RSS.
- No acknowledgements or replay by `Last-Event-ID`; a reconnect receives a fresh `put`, which is simpler and correct because the state is small.
- Browsers limit HTTP/1.1 connections per origin to six; serving the relay over HTTP/2 avoids this for multi-tab users.

## Alternatives considered

- WebSocket: bidirectional, but needs a custom protocol, upgrade handling in every proxy and its own heartbeat anyway.
- Long polling: higher latency and more requests.
