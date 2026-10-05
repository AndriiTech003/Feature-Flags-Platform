# ADR 0002: Hash UTF-8 bytes, not JavaScript string code units

- Status: accepted
- Date: 2026-10-01

## Context

JavaScript strings are UTF-16. Hashing `charCodeAt` values would make `"Київ"`, `"東京"` or `"😀"` hash differently from the same keys in any non-JS SDK (Go, Python, Java hash bytes) and makes the result depend on surrogate handling.

## Decision

The hash input is the UTF-8 encoding of the string, exactly as `TextEncoder` produces it, including replacing lone surrogates with U+FFFD. The evaluator ships its own encoder that writes into a reusable buffer instead of calling `TextEncoder` on every evaluation.

## Consequences

- Cross-language identity; conformance vectors include Cyrillic, CJK, emoji, combining characters, long strings and the empty string.
- The custom encoder avoids an allocation per evaluation (rollout evaluation 0.23 µs on M1). A property test with fast-check checks byte equality with `TextEncoder` on 2000 random strings including lone surrogates.
- Normalization is not applied: `"München"` (precomposed) and `"München"` (decomposed) are different keys. This is documented in the vectors rather than silently normalized, because SDKs in other languages would otherwise have to replicate a Unicode normalization table.
