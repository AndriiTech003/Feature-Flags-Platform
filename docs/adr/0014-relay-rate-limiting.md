# ADR 0014: Relay rate limiting with in-process token buckets

- Status: accepted
- Date: 2026-10-05

## Context

The relay's SDK endpoints are public. Client keys are embedded in web pages, so anyone can call `/sdk/v1/evaluate`, `/sdk/v1/client-stream` and `/sdk/v1/events` with them; key lookups for unknown keys hit Postgres; one SDK or script can flood the event pipeline.

## Decision

- Token buckets per relay process (`apps/relay/src/rate-limit.ts`), bounded to 100 000 buckets with LRU eviction and a periodic sweep of idle (full) buckets.
- Requests with a client key consume from a per-IP bucket (default 50 req/s, burst 200) and a per-key bucket (2000 req/s, burst 5000). Requests with a server key consume from a per-key bucket (100 req/s, burst 500) only, since server SDKs are trusted backends that often share an egress IP.
- Event batches additionally consume one token per event from a per-key event bucket (client 5000/s burst 20 000, server 20 000/s burst 200 000); a single batch above the burst is rejected with 413 instead of 429 because waiting would never help.
- Unknown keys consume from a per-IP invalid-key bucket (2/s, burst 20); when it is empty the relay answers 429 before looking the key up, so random-key guessing cannot load Postgres.
- Body limits: `/sdk/v1/evaluate` 64 KB, client-key POSTs 1 MB, server keys 5 MB.
- Limits are checked in the route's `onRequest` hook, before the body is parsed. A rejection is `429` with `Retry-After` (seconds, at least 1), the scope in the body and `relay_rate_limited_total{scope}` in `/metrics`; `retry-after` is in `Access-Control-Expose-Headers` so browsers can read it.
- Both SDKs honour `Retry-After` on 429 and 503: the stream reconnect and polling wait at least that long (Node SDK through a shared gate, web SDK through `until`), throttled event batches are kept and resent after the delay instead of being dropped, values are capped at 10 minutes.
- All limits are configurable (`RELAY_RATE_LIMIT_*=rate:burst`, `RELAY_RATE_LIMIT=off`), and `RELAY_TRUST_PROXY` makes the client IP come from `X-Forwarded-For` behind a load balancer.

## Consequences

- Limits are per relay instance, so the effective limit scales with the number of instances. A shared Redis limiter would make them global at the cost of a Redis round trip on the hottest endpoint; per-instance buckets behind a load balancer that hashes by client IP are the usual trade-off for flag relays.
- A per-key limit on a public client key is a capacity guard, not abuse protection (an attacker could exhaust it for everyone); that is why it is high and the per-IP limit is the primary control.
