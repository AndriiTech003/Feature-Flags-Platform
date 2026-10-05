# ADR 0007: Change propagation via Redis pub/sub after commit, relay reads Postgres

- Status: superseded by [ADR 0013](0013-transactional-outbox-for-change-notifications.md) (publishing now goes through a transactional outbox; the relay side is unchanged)
- Date: 2026-10-01

## Context

The relay must learn about committed changes quickly and scale horizontally. Every environment has a monotonically increasing `version`, bumped in the same transaction as any flag, segment or experiment change.

## Decision

After a transaction commits, the API publishes `{ type, envId, flagKey | segmentKey, version, envVersion, actor }` to a Redis channel. Every relay instance subscribes, ignores notifications for environments it has no interest in, reloads the environment ruleset from Postgres in one `REPEATABLE READ` snapshot, and broadcasts a `patch`. Notifications for one environment are processed sequentially and older versions are ignored. Every 30 seconds each relay compares cached versions with `environments.version` and reloads anything it missed.

## Consequences

- Patch delivery after commit is ~2 ms in integration tests and under 30 ms p99 for 1000 subscribers in the load test.
- Publishing after commit (not a transactional outbox) means a crash between commit and publish loses the notification; the 30-second version check bounds the staleness, and SDKs also poll with ETag when the stream is down. An outbox would make delivery exactly-once at the cost of a dispatcher process; for flags, "eventually within 30 s in a crash" is acceptable and documented.
- Redis pub/sub channels are global across Redis databases, so channel names include a configurable prefix; tests use a random prefix per run.
- The relay needs read access to Postgres. Separating it fully (API pushes rulesets into Redis) would remove that dependency but duplicate ruleset assembly logic.
