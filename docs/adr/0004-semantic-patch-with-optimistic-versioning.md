# ADR 0004: Semantic patch instructions with If-Match versioning

- Status: accepted
- Date: 2026-10-01

## Context

Several people edit the same flag configuration. A `PUT` of the whole config silently overwrites concurrent edits, and the audit log can only say "config changed".

## Decision

`PATCH /projects/:p/flags/:key/envs/:env` takes a list of intent-level instructions (`turnOn`, `addRule`, `updateRuleClauses`, `reorderRules`, `updateFallthrough`, `addTargets`, …). The list is applied atomically inside a transaction that locks the config row (`SELECT … FOR UPDATE`). An optional `If-Match: "<version>"` makes the request fail with 409 when the config changed since the client read it. Change requests and scheduled changes store instruction lists and re-apply them to the current config at apply time.

## Consequences

- Concurrent edits to different rules both succeed when the client does not send `If-Match`; the dashboard sends it, so a user who edited a stale view sees a conflict instead of overwriting.
- The audit log stores the instructions and a generated description ("added rule: country in [DE] → On") next to the before/after JSON and diff.
- A change request approved against version 3 still applies on version 5 if its instructions are still valid; if not (rule deleted meanwhile) it is marked `failed` with the reason.
- The dashboard edits a local draft and derives instructions with `instructionsBetween(original, draft)`, which is tested to reproduce the target config exactly. Cost: two representations (instructions and full config) must stay in sync; `applyInstructions` lives in the shared contracts package used by both API and dashboard.

## Alternatives considered

- JSON Patch (RFC 6902): generic, but paths are index-based (`/rules/2`), so reorders and concurrent edits become fragile, and intent is lost.
- Full PUT with ETag only: simple, but every concurrent edit becomes a conflict.
