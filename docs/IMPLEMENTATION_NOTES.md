# Implementation notes

Built against `README.md` and `docs/SPEC.md`, `docs/SDK.md`, `docs/ROADMAP.md` (M1 → M5), following `devinfra/CONVENTIONS.md`.
Verification date: 2026-10-01, re-verified after closing the gaps on 2026-10-05 (see "Changes on 2026-10-05"), Apple M1 (8 cores), macOS (Darwin 27), Node 26.7.0, pnpm 10.34.6, PostgreSQL 16 and Redis 8 from devinfra.

## Layout

| Path | What |
|---|---|
| `packages/evaluator` | `@ashamrai/flags-evaluator`: pure evaluation core, own murmurhash3 (UTF-8), semver, bucketing, prerequisites with cycle detection, reasons, never throws |
| `packages/contracts` | `@ashamrai/flags-contracts`: zod schemas, semantic patch (`applyInstructions`, `instructionsBetween`, `describeInstruction`), `jsonDiff`, SDK event schemas |
| `packages/conformance` | private: 185 evaluation vectors + 24 hash vectors (`vectors/*.json`) and the shared runner |
| `packages/sdk-node` | `@ashamrai/flags-node`: SSE client over fetch, polling + ETag fallback, persistent store, event processor with LRU exposure dedupe, summaries, diagnostics |
| `packages/sdk-node-redis` | `@ashamrai/flags-node-redis`: Redis `PersistentStore` |
| `packages/sdk-web` | `@ashamrai/flags-web`: client-side SDK (3.4 KB gzip), localStorage cache, bootstrap, sendBeacon, honours `Retry-After` |
| `packages/sdk-react` | `@ashamrai/flags-react`: provider, `useFlag`, `useFlagDetail` on `useSyncExternalStore` |
| `packages/openfeature-node`, `packages/openfeature-web` | OpenFeature providers |
| `packages/cli` | `@ashamrai/flags-cli`: `login`, `codegen`, `find-stale` |
| `apps/api` | NestJS management API (port 4200), migrations, seed, scheduled-change worker, webhooks, experiments statistics, transactional outbox publisher (in-process or `node dist/outbox-main.js`), OpenAPI at `/openapi.json` and `/docs` |
| `apps/relay` | Fastify relay (port 4210): ruleset + ETag/304, SSE `put`/`patch`/heartbeat, client evaluate, client stream, events, token-bucket rate limits, `/metrics` |
| `apps/dashboard` | React 19 + Vite + TanStack Router/Query + shadcn-style Radix components (dev 4220, preview 4221), lazy routes + vendor chunks, `scripts/check-size.mjs` budget |
| `apps/demo-shop` | Express shop using both SDKs with a debug panel (port 4230), `/checkout` page per `new-checkout`, traffic generator |
| `e2e/` | Playwright suite (ports 4250–4253) |
| `scripts/` | `smoke.sh` + `smoke.mjs` (ports 4260–4263), `loadtest.mjs` (4270–4271), `pack-check.mjs` |
| `docs/adr/` | 14 ADRs (0007 superseded by 0013) |

## How to run

```sh
/Users/asnh/Desktop/projects_for_git/devinfra/start.sh   # Postgres, Redis (others unused)
pnpm install
pnpm build
pnpm seed            # creates database ffp, migrates, seeds demo data (add -- --reset to recreate)
pnpm dev             # api :4200, relay :4210, dashboard :4220, demo-shop :4230
pnpm traffic         # 27 000 simulated shoppers, +8% relative conversion on banner-text variant B
```

Logins: `demo@demo.dev` (admin), `reviewer@demo.dev` (writer), `viewer@demo.dev` (reader), password `demo1234`.
Seeded SDK keys: `srv-demo-<env>` and `cli-demo-<env>` for development, staging, production (fixed values for the local demo only).
Redis: db 2, all channels and keys prefixed with `REDIS_PREFIX` (default `ffp`). Postgres: `ffp`, tests use throwaway `ffp_test_*` databases that are dropped afterwards.

Other commands: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm test:browser` (`VITEST_BROWSERS=chromium,webkit` for more engines), `pnpm test:integration` (`TESTCONTAINERS=1` to use Testcontainers instead of devinfra), `pnpm test:coverage:api` (API unit + integration with coverage thresholds), `pnpm test:e2e`, `pnpm smoke`, `pnpm bench`, `pnpm loadtest`, `pnpm size` (SDK size-limit and the dashboard chunk budget), `pnpm publint`, `pnpm attw`, `pnpm pack:check`, `pnpm docs:api` (TypeDoc into `docs-site/`), `make <target>` mirrors them. `docker compose up --build` is the containerized path (see deviations).

## What was verified (commands actually run, all passing)

| Step | Command | Result |
|---|---|---|
| Clean install | removed every `node_modules`, `dist`, `.turbo`, then `pnpm install --frozen-lockfile` | ok |
| Lint | `pnpm lint` (ESLint + typescript-eslint + react-hooks + a local `no-comments` rule enforcing the convention) | 0 problems |
| Format | `pnpm format:check` | all files formatted |
| Typecheck | `pnpm typecheck` | 21/21 turbo tasks (0 cached) |
| Build | `pnpm build` | 14/14 turbo tasks |
| Unit + property + conformance | `pnpm test` | **690 tests, 0 failed**: evaluator 233, relay 211, sdk-node 206, contracts 10, api 9, dashboard 8, openfeature-node 4, cli 3, sdk-react 3, demo-shop 2, openfeature-web 1 |
| Evaluator coverage | `vitest --coverage` (thresholds 95/90/95/95) | statements 99.03%, branches 97.51%, functions 100%, lines 100% |
| Browser (real engines) | `VITEST_BROWSERS=chromium,webkit pnpm test:browser` | **766 tests, 0 failed**: evaluator 374 (187 × 2 engines), sdk-web 392 (196 × 2) |
| Integration (Postgres + Redis) | `pnpm test:integration` | **33 tests, 0 failed**: api 25 (18 + 7 outbox), relay 6 (5 + publisher crash), sdk-node-redis 2; run 5 times in a row without a failure |
| API coverage | `pnpm test:coverage:api` (unit + integration, thresholds 70/60/72/75) | 34 tests; statements 73.8%, branches 62.4%, functions 76.6%, lines 78.6% |
| E2E | `pnpm test:e2e` | **6 passed** (new: route and chart chunks load lazily) |
| Smoke | `pnpm smoke` | **32 checks passed** (new: code-split dashboard, outbox listening and drained, relay 429 + `Retry-After`), exit 0, all started processes stopped, database dropped |
| Bundle size | `pnpm size` | flags-web 3.4 KB gzip (limit 5 KB), evaluator 3.48 KB brotli (limit 4 KB), flags-react 665 B (limit 1.5 KB); dashboard largest chunk 359.1 kB (budget 400 kB), initial JavaScript 202.6 kB gzip (budget 260 kB) |
| publint / attw | `pnpm publint`, `pnpm attw` | 9/9 packages "All good" / "No problems found" (node16 CJS, node16 ESM, bundler) |
| pack | `pnpm pack:check` | 9 tarballs with dist ESM + CJS + d.ts + README + LICENSE, no `workspace:` leaks; installed into a clean npm project, ESM and CJS smoke code and the `flags` bin ran |
| Load test | `pnpm loadtest` | see below (2026-10-01 run; not repeated on 2026-10-05, the relay is started with `RELAY_RATE_LIMIT=off` for it) |
| TypeDoc | `pnpm docs:api` | site generated |

Conformance runs: the same 185 vectors pass for the evaluator (Node, Chromium, WebKit), `@ashamrai/flags-node`, `@ashamrai/flags-web` in Chromium and WebKit (evaluated by a real relay over HTTP) and the relay's server-side evaluation over HTTP. Hash and rollout expectations were produced by a reference C implementation of murmurhash3_x86_32 (compiled with clang), checked against the published values `hello → 0x248bfa47` and `The quick brown fox… → 0x2e4ff723`.

Required scenarios and where they are tested:

| Requirement | Test |
|---|---|
| SSE subscriber receives a patch < 500 ms after a flag change | `apps/relay/test/integration/relay.test.ts` (10 changes, now through the outbox; measured 1.7–4.4 ms after commit, 7–25 ms including the API request) |
| No lost update between commit and publish | `apps/api/test/integration/outbox.test.ts`, `apps/relay/test/integration/outbox-crash.test.ts` (publisher process frozen before the commit, SIGKILLed, restarted: patch on the SSE stream 175–490 ms after restart, relay recheck at 60 s) |
| Relay rate limits + SDKs honour `Retry-After` | `apps/relay/test/unit/rate-limit.test.ts`, `packages/sdk-node/test/resilience.test.ts` ("honours Retry-After"), `packages/sdk-web/test/retry-after.browser.test.ts`, smoke |
| Dashboard chunk budget | `apps/dashboard/test/bundle.test.ts`, `pnpm size`, e2e test 6 |
| 409 on stale version | `apps/api/test/integration/api.test.ts` "applies instructions with If-Match…", smoke |
| Change request flow | API integration (approval required, author cannot approve, reader forbidden, apply, failed when no longer applicable), e2e with two users, smoke |
| Scheduled change executes | API integration (exactly once with three concurrent `runDue` calls, `FOR UPDATE SKIP LOCKED`; background worker), smoke |
| SDK resilience | `packages/sdk-node/test/resilience.test.ts`: relay down at start, relay dies mid-stream, broken stream, slow relay, heartbeat timeout, polling ETag, persistent store, never throws; web equivalents in `packages/sdk-web/test/client.browser.test.ts` |
| Monotonic rollout, uniformity χ², independence, never throws | `packages/evaluator/test/properties.test.ts` (fast-check) |
| Leak test (1M evaluations + 1000 patches) | `packages/sdk-node/test/leak.test.ts` (`--expose-gc`, heap growth < 10 MB) |
| Exposure dedupe, summary, beacon | sdk-node unit + resilience tests, sdk-web browser test (sendBeacon on `visibilitychange`) |
| Client SDK never receives rules | relay unit + integration tests, sdk-web browser test, smoke |
| Audit with diff and author | API integration, e2e |
| Experiment detects the built-in effect | smoke (27 000 visitors: B +7.6% relative, p = 0.001, SRM p = 0.37) and the API integration test with known data (rates 40% vs 60%, CI > 0, SRM detection on a skewed split) |
| Dashboard flow create → 50% → playground → demo-shop without reload | `e2e/flags.e2e.ts` test 1 (asserts a `window` marker survives, value equals the playground result) |
| "Flag was updated by X" banner | e2e test 4 |

## Benchmarks

Evaluator, `pnpm bench` (tinybench, 1 s per case after 300 ms warmup), Apple M1, Node 26.7.0. Two runs on the same day: the first while the machine was quiet, the second while another project's load test and several other applications were running (load average > 30).

| Case | Quiet run mean | Loaded run mean / p99 | Target |
|---|---|---|---|
| boolean flag, off | 0.071 µs | 0.135 / 0.208 µs | < 0.3 µs |
| 5 rules × 3 clauses, match in last | 0.383 µs | 0.703 / 0.875 µs | < 5 µs |
| rollout 50/50 (murmurhash) | 0.231 µs | 0.451 / 0.709 µs | < 1 µs |
| segment with 1000 included keys | 0.106 µs | 0.186 / 0.250 µs | < 1 µs |
| regex clause | 0.134 µs | 0.223 / 0.291 µs | < 3 µs |

Raw output of the loaded run: `docs/benchmarks/evaluator-bench-2026-10-01.json`.

Load test, `pnpm loadtest` (`docs/benchmarks/loadtest-results.json`), API + relay + Postgres + Redis + the load generator on the same laptop:

| Scenario | Result |
|---|---|
| SSE connections opened on one relay process | 3000 (RSS 85 MB idle → 120 MB with 1000 → 147 MB with 3000) |
| Patch fan-out to 1000 subscribers, measured from the API response (commit) | 5 rounds: p50 8.8–14.5 ms, p95 14.3–25.4 ms, p99 14.7–26.2 ms, all 1000 delivered every round |
| `POST /sdk/v1/evaluate`, 64 concurrent, 10 s | 28 588 requests, 2 859 req/s, 0 errors, p50 21 ms, p95 38 ms, p99 50 ms |
| Experiment results, 27 000 units × 2 metrics | 3.7 s before optimization, 1.1 s after (single pass, materialized CTEs, hash join) |
| Traffic generator | 27 000 visitors with exposures, purchases and add-to-cart events in 1.1–5.4 s |

## Deviations from the spec and decisions taken

1. **Versions.** NestJS 11 (12 was released days ago and is ESM-only with new peer ranges), TypeScript 6.0.3 (TypeScript 7 is the Go port; typescript-eslint and tsup's d.ts build need ≤ 6.0), Vitest 5, Playwright 1.63, zod 4. `ignoreDeprecations: "6.0"` is set because tsup's dts step injects `baseUrl`.
2. **NestJS without decorator metadata.** esbuild-based tools do not emit `design:paramtypes`, so every dependency uses `@Inject(Token)` and validation uses zod pipes from the shared contracts package instead of class-validator (ADR 0011). OpenAPI is generated from registered routes plus zod schemas; a test fails on any undocumented route.
3. **Project keys are globally unique**, because the spec's URLs (`/projects/:p/...`) contain no organization. Webhooks are organization-scoped (`/webhooks?orgId=`, default: the user's first organization) and can be limited to one project.
4. **Members.** "Invite" creates the account immediately and returns a one-time temporary password (no email delivery; Mailpit is available but not used).
5. **GitHub OAuth** (`/auth/github`, `/auth/github/callback`) is implemented and enabled by `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, but not exercised by tests (needs a real OAuth app).
6. **Data model additions.** `segments.context_kind` (segments for organizations), `flags.client_side_available`, an `experiment` reference inside the flag config sent to SDKs (drives `inExperiment`), nullable `offVariation` (SDK default when null), and tables `flag_eval_counts`, `flag_last_seen`, `context_attributes`, `sdk_diagnostics`, `webhook_deliveries`.
7. **Summary events.** Besides exposures and custom events, SDKs send per-flush evaluation counters (`summary`). Insights ("evaluations by variation for 24 h / 7 d, last evaluated") are computed from them; deduplicated exposures alone would undercount.
8. **Experiment unit key.** Events carry `contextKey` = the `user` key when present, otherwise the single context's key, otherwise a canonical `kind:key:…` string. The same rule is implemented in the Node SDK, web SDK and relay so exposures and `track()` join.
9. **Missing attributes never match**, even with `negate` (LaunchDarkly semantics). This and other edge semantics (empty clause list matches everyone, bucket 0 when the bucketing attribute is missing, last variation when weights sum below 100 000, Unicode is not normalized) are pinned in the conformance vectors.
10. **Change notifications go through a transactional outbox** (ADR 0013, supersedes the publishing half of ADR 0007). The relay still re-checks environment versions every 30 s, but only as a safety net; SDKs poll with ETag while disconnected. Delivery is at-least-once; relays ignore versions they already have and send a full `put` whenever notifications are not consecutive.
11. **Seed data is deterministic**: fixed demo SDK keys and flag salts derived from the flag key, so the smoke test's experiment outcome is reproducible. Seed also inserts 7 days of synthetic evaluation counts so the insights chart is not empty on a fresh install (`--no-history` to skip); real traffic from the generator is added on top.
12. **Smoke test "variant C is not significant"** is informational: C has no built-in effect, so with three variations a false positive at α = 0.05 is possible by chance (the UI shows the Bonferroni warning). The hard checks are: B detected with positive lift, no SRM, every visitor counted once.
13. **Patch latency measurement.** The integration test asserts both "delivery after commit" and "including the API request" are < 500 ms. While investigating, round trips inside a single Vitest worker process (test client + API + relay in one Node process) occasionally took 250–500 ms although the server handled each request in < 8 ms and relay delivery took ~2 ms; with an active event-loop monitor (5 ms timer) they dropped to ~10 ms. This looks like slow idle wake-ups of that worker on this machine, not application latency (separate processes in smoke/e2e/load tests do not show it). The test keeps the monitor enabled and reports the event-loop delay.
14. **Browsers.** Chromium and WebKit run locally. Firefox (Playwright build 1543) fails to start on this macOS version ("Could not find profile folder", also outside the sandbox), so it is not part of the verified browser set (re-checked on 2026-10-05, same error).
15. **Docker.** `docker-compose.yml` and Dockerfiles for api, relay, dashboard (nginx, runtime `config.js`) and demo-shop are written per spec but were not built: Docker is not installed here. The equivalent processes were verified with `node dist/...` in the smoke test and e2e.
16. **Testcontainers.** Integration tests use Testcontainers when `TESTCONTAINERS=1`; locally they use devinfra with a throwaway `ffp_test_*` database and a random Redis prefix. The Testcontainers path was not executed (no Docker).
17. **Publishing.** Packages are `0.0.0`; nothing was published. Release automation (changesets, GitHub workflows) was removed at the user's request: no git or git-related tooling in this workspace.
18. **Not doable locally (ROADMAP M5):** deployment to the VPS, the 90-second video and the GIF, and integrating `@ashamrai/flags-node` into project 01 (`commerce-intelligence-platform` contains only docs). Screenshots from a real local run are in `docs/screenshots/`.
19. **OpenFeature tests.** There is no official, provider-agnostic OpenFeature test suite to run; the providers are tested with an own suite against the specification (resolution reasons, error codes, context mapping, events, tracking, initialization failure).
20. **Dashboard specifics.** Webhooks and Members are pages inside the project layout (members of the project's organization). Every project page is a lazy route (`lazyRouteComponent`), third-party code is split into vendor chunks (react, router, radix, forms, icons, charts, dnd); Recharts and dnd-kit load only with the flag/experiment detail pages. Attribute autocomplete uses context attributes recorded by the relay from client evaluations and exposure events (names only, no values).
21. **Demo shop** is Express (the spec allowed Next.js or Express). The server renders with `allFlagsState` as bootstrap and the browser keeps values live through `@ashamrai/flags-web`; `/checkout` renders the one-page or the classic 3-step checkout depending on `new-checkout`.
22. **No git tooling.** Per the user, there are no git hooks, no `.github` workflows and no changesets. Quality gates run through `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e` and `pnpm smoke`.
23. **Turborepo strict env mode.** Test-related variables (`VITEST_BROWSERS`, `TEST_DATABASE_ADMIN_URL`, `TEST_REDIS_URL`, `TESTCONTAINERS`, `CI`) are declared in `globalPassThroughEnv`; `VITE_*` is a build input of the dashboard. `agentGuidance` is disabled so turbo does not write an `AGENTS.md` into the project.

## Changes on 2026-10-05 (closing the gaps)

1. **Relay rate limiting** (ADR 0014, `apps/relay/src/rate-limit.ts`). In-process token buckets, bounded to 100 000 entries with LRU eviction and a periodic sweep. Client-key requests (evaluate, client-stream, events, beacons) are limited per IP (50/s, burst 200) and per key (2000/s, burst 5000); server-key requests per key (100/s, burst 500). Event batches also consume one token per event from a per-key event bucket (client 5000/s burst 20 000, server 20 000/s burst 200 000); a batch larger than the burst is `413`. Unknown keys consume a per-IP invalid-key bucket (2/s, burst 20) and further lookups from that IP get `429` before touching Postgres. Body limits: evaluate 64 KB, client-key POSTs 1 MB. Checks run in the route `onRequest` hook (before body parsing). Rejections are `429` + `Retry-After` (exposed via CORS) + `relay_rate_limited_total{scope}`. All limits are configurable (`RELAY_RATE_LIMIT_*=rate:burst`, `RELAY_RATE_LIMIT=off`), `RELAY_TRUST_PROXY` (`true`, hop count or address list) takes the client IP from `X-Forwarded-For`.
2. **SDKs honour `Retry-After`** on `429`/`503` (seconds or HTTP date, capped at 10 minutes). Node SDK: one gate shared by stream reconnects and polling, a separate one for events; throttled event batches stay queued and are resent after the delay (dropped with a warning only if the client is closed while still throttled); `status().throttled`. Web SDK: stream connects, evaluate calls and polling wait for `until`; throttled events are re-queued, beacons are skipped while throttled. Web SDK grew from 3.13 to 3.4 KB gzip.
3. **Transactional outbox** (ADR 0013, `apps/api/src/outbox/`). Migration `003_change_outbox`. Every path that bumps an environment version (flag patch, flag create/update/archive/delete, segments, environment settings, experiment start/stop, change requests, scheduled changes) and SDK key rotation/revocation insert the notification in the same transaction plus `pg_notify`. `OutboxPublisher` listens on `ffp_change_outbox`, drains with `FOR UPDATE SKIP LOCKED` in batches of 100, deletes published rows, records `attempts`/`last_error` on a failed publish, reconnects the LISTEN connection and polls every `OUTBOX_POLL_MS` (1 s) as a fallback. It runs inside every API process (`OUTBOX_PUBLISHER=true`) and as `node apps/api/dist/outbox-main.js`. `/health` reports `outbox.{listening, published, failures, pending}`. `Db.tx` now keeps an `error` listener on the checked-out client and destroys broken connections, so a backend killed mid-transaction cannot crash the process.
4. **Relay patch correctness with reordered notifications.** A `patch` is only sent when the cached version is exactly one below the notification and the reloaded snapshot has that version; otherwise server streams get a full `put`. Before, two quick changes could leave server SDKs with a stale flag until the next reconnect (unit test "sends a full put instead of a patch when notifications skip or reorder versions").
5. **Dashboard code splitting.** Lazy route components with a pending skeleton, vendor chunk groups (`apps/dashboard/vendor-chunks.ts`) and `scripts/check-size.mjs` (wired to `pnpm size`): every JS/CSS chunk ≤ 400 kB raw, initial JavaScript ≤ 260 kB gzip, `vendor-charts`, `vendor-dnd`, `flag-detail`, `experiment-detail` must not be loaded eagerly. Before: one 1.2 MB chunk; now 31 files, largest `vendor-charts` 359 kB (lazy).
6. **API coverage is measured**: `pnpm test:coverage:api` runs unit + integration with v8 coverage and thresholds just under the measured values.
7. Smoke: the SSE latency check now waits for the actual `patch` event (it used to match the flag key already present in the initial `put`), and the relay-propagation check waits for the outbox instead of assuming the change is visible on the relay the moment the API answers (it is eventually consistent, typically a few ms). While investigating, a client-side artifact showed up: in a Node process that is reading a streaming `fetch` body, the next `fetch` to another origin took ~450 ms, while the same request via `node:http` or curl took 9–13 ms; the smoke no longer prints that request time as if it were server latency.
8. README.public.md, the SDK READMEs and `.env.example` describe the new behaviour; the Changesets mention in README.public.md was removed (it was deleted from the workspace earlier).

## Known gaps

- Rate limits are per relay instance (in-memory); a global limit across instances would need a shared store (Redis) and an extra round trip on the hottest endpoint.
- Segment lists are limited to 10 000 keys (zod limit); larger lists would need a separate store and Bloom filters. The spec defines this as an MVP limit.
- Statistics are fixed-horizon (warnings for peeking and multiple comparisons, no sequential testing or CUPED); attribution has no conversion window. Beyond what the spec asks for.
- API coverage is measured but moderate (statements 74%, branches 62%); the uncovered code is mostly error branches, GitHub OAuth and OpenAPI/insights formatting.
- Still not doable locally: Firefox (Playwright build 1543 still fails with "Could not find profile folder" on this macOS, also with a different `TMPDIR`), Docker/Testcontainers (no Docker), GitHub OAuth against a real app, deployment, video, publishing.
- The load test (`pnpm loadtest`) was not re-run after these changes; the numbers above are from 2026-10-01.
