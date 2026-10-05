# ADR 0012: Shared conformance vectors with an independent oracle

- Status: accepted
- Date: 2026-10-01

## Context

"The same user gets the same variation everywhere" is the core promise. Unit tests per SDK drift; expected values computed by the code under test prove nothing.

## Decision

`packages/conformance/vectors/*.json` contains 185 evaluation cases (every operator, targets, rules, segments, prerequisites and cycles, multi-contexts, missing attributes, wrong types, invalid contexts, unicode, rollouts) and 24 hash vectors. Rollout and hash expectations were computed by a reference C implementation of murmurhash3_x86_32, not by the TypeScript evaluator. One runner (`registerConformanceSuite`) executes them against: the evaluator in Node, the evaluator in Chromium and WebKit, `@ashamrai/flags-node`, `@ashamrai/flags-web` in a real browser (through a relay), and the relay's server-side evaluation over HTTP.

## Consequences

- A new SDK in any language is "done" when it passes the JSON vectors.
- Changing semantics requires changing a vector, which makes behaviour changes visible in review.
- Client-side runs apply the SDK's default and type handling on top of the relay's result, so they test the whole client path, not only the evaluator.
