# ADR 0003: Evaluation reasons are part of the public API

- Status: accepted
- Date: 2026-10-01

## Context

"Why did user X get variation B?" is the most common support question for a flag system. Experiments also need to know whether a value came from a rollout inside a running experiment.

## Decision

Every evaluation returns `{ value, variationId, reason }` with a closed set of reason kinds: `OFF`, `TARGET_MATCH`, `RULE_MATCH { ruleIndex, ruleId, inExperiment? }`, `FALLTHROUGH { inExperiment? }`, `PREREQUISITE_FAILED { prerequisiteKey }`, `ERROR { errorKind }` with `FLAG_NOT_FOUND | MALFORMED_FLAG | WRONG_TYPE | INVALID_CONTEXT | EXCEPTION` (SDKs add `CLIENT_NOT_READY`). Reasons are asserted by the conformance vectors, not just values.

## Consequences

- The dashboard playground, the demo-shop debug panel and OpenFeature metadata explain decisions without extra code.
- Reasons are a compatibility surface: adding a field is a minor change, renaming a kind is a major change. This is why they are in the conformance vectors.
- The evaluator never throws; every failure is a reason. This makes "SDK never breaks the app" testable (fast-check "never throws" property).
- Client SDKs receive reasons only when they ask (`withReasons`), to keep payloads small.
