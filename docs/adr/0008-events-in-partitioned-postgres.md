# ADR 0008: Exposure and metric events in a partitioned Postgres table

- Status: accepted
- Date: 2026-10-01

## Context

Experiments need exposure and custom events; insights need evaluation counts. Volumes in this project are thousands to millions of rows per day, not billions.

## Decision

`events` is `PARTITION BY RANGE (ts)` with one partition per day, created by a `ensure_event_partitions(start, days)` PL/pgSQL function at migration time and hourly by the worker (30 days back, 7 days ahead), plus a `DEFAULT` partition for out-of-range timestamps. `drop_old_event_partitions(keep_days)` implements retention by dropping partitions. Evaluation counts come from SDK summary events and are upserted into an hourly `flag_eval_counts` table rather than counting raw rows.

## Consequences

- One database to operate; experiment results are a single SQL query (units materialized once, custom events filtered by time and key, hash join). 27 000 units with two metrics compute in about 1 s on a laptop.
- Retention is O(1) (`DROP TABLE` of a partition) instead of massive `DELETE`s.
- SDK-side exposure dedupe (LRU, 1 hour) keeps the event table proportional to unique context × flag × variation, not to evaluations.
- At ClickHouse scale (billions of rows, ad-hoc slicing) Postgres would be the bottleneck; the event writer is isolated in the relay's `ingest`, so swapping the sink is localized.
- No `pg_partman` dependency, so the schema works on any vanilla Postgres 16.
