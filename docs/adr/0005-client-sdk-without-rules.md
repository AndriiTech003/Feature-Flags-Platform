# ADR 0005: The browser SDK receives evaluated values, never rules

- Status: accepted
- Date: 2026-10-01

## Context

Targeting rules contain email addresses, internal segment names, customer lists and the names of features that are not announced yet. Anything sent to a browser is public.

## Decision

Client keys can only call `POST /sdk/v1/evaluate` and `GET /sdk/v1/client-stream`; the relay evaluates flags marked `clientSideAvailable` for the given context and returns `{ value, variationId, version, reason? }`. Server keys can download the ruleset; client keys get 403 there.

## Consequences

- Privacy by design, tested: relay unit and integration tests assert that responses to client keys contain no `rules`, `targets`, `salt`, segment names or non-client flags.
- The web SDK is 3.1 KB gzip because it contains no evaluator.
- Every context change (`identify`) costs a round trip; the localStorage cache and SSR bootstrap hide it on page load.
- The relay re-evaluates every connected client context on each change (CPU proportional to client streams × client flags). Measured: 1000 subscribers get a patch in under 30 ms p99 locally; past tens of thousands of client streams per instance this would need batching or sharding by environment.
- Client keys are not secrets; abuse protection is rate limiting at the edge (not implemented, see Known limitations).
