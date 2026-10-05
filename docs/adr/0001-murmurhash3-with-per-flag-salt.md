# ADR 0001: Bucketing with murmurhash3_x86_32 and a per-flag salt

- Status: accepted
- Date: 2026-10-01

## Context

Percentage rollouts and experiments must put a given context into the same bucket on every server instance, in every SDK and in the browser, without coordination or storage. Two flags at 10% must not select the same 10% of users, otherwise every experiment overlaps with every rollout.

## Decision

`bucket = murmurhash3_x86_32(UTF-8("<flagKey>.<salt>.<bucketKey>"), seed 0) % 100000`, where `salt` is a random 64-bit hex string generated when the flag is created and never changed. Weights are expressed in thousandths of a percent (sum 100000) and mapped to cumulative intervals in the order of the weights list.

## Consequences

- Deterministic and stateless: the relay, `@ashamrai/flags-node`, the dashboard playground and any future SDK compute the same bucket. Verified by conformance vectors whose expected buckets come from the reference C implementation.
- Monotonic: raising a variation's weight extends its interval, so users already in it stay (property test: 100k keys, 10% → 20%).
- Independent: different salts decorrelate flags (property test: correlation < 0.01 over 200k keys).
- Uniform enough: χ² over 1M keys in 100 buckets, p > 0.01.
- `% 100000` on a 32-bit hash has a modulo bias of about 2 × 10⁻⁵, negligible for rollouts.
- Rotating the salt reshuffles everyone, so it is deliberately not exposed in the UI; "re-randomize an experiment" would be a separate explicit action.

## Alternatives considered

- SHA-1 of the same input (LaunchDarkly's historic choice): cryptographic hashing is unnecessary here, slower, and needs `crypto.subtle` (async) in browsers.
- xxHash: faster but no reference implementations in every language we may want SDKs in.
- Hashing only `bucketKey` with a global seed: identical users would land in the same 10% for every flag.
