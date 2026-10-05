# ADR 0013: Transactional outbox for change notifications

- Status: accepted
- Date: 2026-10-05
- Supersedes: [ADR 0007](0007-change-propagation-via-redis-pubsub.md) (the publishing half)

## Context

ADR 0007 published change notifications to Redis after the database transaction committed. A crash, deploy or Redis hiccup between `COMMIT` and `PUBLISH` lost the notification, and relays only noticed the change at their next 30-second version check. For a kill switch, 30 seconds is too long.

## Decision

- Every code path that bumps `environments.version` (flag patch, flag create/update/archive/delete, segment create/update/delete, environment settings, experiment start/stop, change-request apply, scheduled change) and every SDK key rotation/revocation inserts its notification into `change_outbox (id bigserial, topic, payload jsonb, attempts, last_error)` **inside the same transaction** and calls `pg_notify('ffp_change_outbox', topic)`. A rolled-back change therefore never produces a notification, and a committed change always has one.
- An outbox publisher keeps a dedicated connection with `LISTEN ffp_change_outbox`. On every notification (delivered by Postgres only after commit), on start and on a 1 s safety poll it drains: `SELECT … ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`, `PUBLISH` each row to Redis, `DELETE` the published rows, `COMMIT`. A failed publish increments `attempts`, stores `last_error`, keeps the row and stops the batch; the next drain retries it.
- The publisher runs inside every API process by default (`OUTBOX_PUBLISHER=true`) and can run as a separate process (`node apps/api/dist/outbox-main.js`). Several publishers share the work through `SKIP LOCKED`; if one dies while holding claimed rows, Postgres aborts its transaction, releases the locks, and another publisher (or the restarted one) delivers them.
- The LISTEN connection reconnects after errors; while it is down the safety poll bounds latency to `OUTBOX_POLL_MS`.
- Relays are unchanged except for one correction: a `patch` is only sent when the cached version is exactly one below the notification and the reloaded snapshot has exactly that version. Otherwise (reordered or coalesced notifications, which multiple publishers make possible) the relay sends a full `put`. The 30-second version check stays as a safety net only.

## Consequences

- Delivery is at-least-once: a publisher that crashes after `PUBLISH` but before `COMMIT` republishes; relays ignore notifications whose version they already have, so duplicates are harmless.
- One extra insert and `pg_notify` per change and one extra Postgres connection per publisher. Normal latency is unchanged (LISTEN wake-up, 2–4 ms after commit in the integration test).
- Tests: `apps/api/test/integration/outbox.test.ts` (same transaction, rollback, every change type, LISTEN wake-up and reconnect, 300 rows × 3 concurrent publishers exactly once, retry after a failed publish, a publisher whose backend is terminated while holding locks) and `apps/relay/test/integration/outbox-crash.test.ts` (separate publisher process frozen with SIGSTOP before the commit, killed with SIGKILL, restarted: the SSE subscriber receives the patch ~0.2 s after restart while the relay recheck interval is 60 s).
