# ROADMAP · Feature Flags Platform (4–5 недель)

## M1 — Evaluator + conformance (1 неделя)
- [ ] Монорепо (pnpm + Turborepo + Changesets)
- [ ] `packages/contracts`: zod-схемы Flag, FlagConfig, Segment, Context, Ruleset
- [ ] `packages/evaluator`: алгоритм, операторы, семвер, murmurhash3 (своя реализация, UTF-8), бакетинг, prerequisites с защитой от циклов
- [ ] `packages/conformance`: ~150 test vectors + раннер
- [ ] Property-тесты (fast-check): монотонность, равномерность (χ²), независимость, «никогда не бросает»
- [ ] Бенчмарки
- [ ] ADR: murmurhash + salt, UTF-8 для хэширования, reasons как часть API

**Готово, когда:** evaluator проходит все vectors, бенчмарки в README, покрытие > 95% (для чистого ядра это разумная цель).

## M2 — API + Relay + Dashboard MVP (1.5 недели)
- [ ] API: auth, проекты, окружения, флаги, конфиги, семантический патч + версии (409), сегменты, SDK-ключи, аудит
- [ ] Relay: ruleset + ETag, SSE stream (put/patch/heartbeat), client evaluate, Redis pub/sub
- [ ] Dashboard: список флагов, детальная страница, редактор правил, rollout-слайдер, pending changes + diff, playground
- [ ] Integration-тесты (Testcontainers): изменение флага → patch приходит SSE-подписчику < 500 мс
- [ ] ADR: семантический патч, клиентский SDK без правил, SSE vs WebSocket

## M3 — SDK + npm (1 неделя)
- [ ] `sdk-node`: SSE-клиент, polling fallback, store, events, diagnostics, graceful close
- [ ] `sdk-web`: evaluate + stream, localStorage-кэш, bootstrap, sendBeacon
- [ ] `sdk-react`: provider, хуки на `useSyncExternalStore`
- [ ] Conformance в каждом SDK (web — в браузере через Playwright)
- [ ] Тесты отказов: relay недоступен при старте, relay падает во время работы, «битый» SSE-поток, медленный relay → default + восстановление
- [ ] Сборка tsup, publint, attw, size-limit, публикация `0.1.0` с provenance
- [ ] Demo-shop с debug-панелью

**Готово, когда:** `npm i @scope/flags-node` в чистом проекте работает по README за 2 минуты.

## M4 — Эксперименты, governance, OpenFeature (1 неделя)
- [ ] Events endpoint, партиционированная таблица, дедуп экспозиций в SDK
- [ ] Метрики, эксперименты, z-тест / t-тест, CI, lift, SRM, калькулятор размера выборки
- [ ] Генератор трафика demo-shop с заложенным эффектом → эксперимент его находит
- [ ] Change requests (prod approval), scheduled changes, compare & copy environments
- [ ] Insights (оценки по вариациям, stale flags)
- [ ] OpenFeature providers (node + web)
- [ ] (Опционально) CLI: codegen, find-stale

## M5 — Полировка (0.5–1 неделя)
- [ ] Деплой: relay + API + dashboard + demo-shop на тот же VPS, что и проект 01
- [ ] Нагрузка: число SSE-соединений на инстанс relay, время доставки patch при 1000 подписчиках, RPS client evaluate
- [ ] Публичный README (EN), TypeDoc на GitHub Pages, GIF «изменил флаг → сайт поменялся»
- [ ] Видео 90 секунд
- [ ] **Интеграция с проектом 01**: `commerce-intelligence-platform` использует `@scope/flags-node` для фичи «AI creatives». Упомянуть в обоих README

## Тесты — сводка
| Уровень | Что |
|---|---|
| Unit + property | evaluator, операторы, бакетинг, статистика экспериментов |
| Conformance | один набор vectors для evaluator, sdk-node, sdk-web, relay |
| Integration | API + Postgres + Redis, relay-стриминг, change requests, scheduled changes |
| Resilience | SDK при недоступном или медленном relay, reconnect, stale data |
| E2E | Dashboard: создать флаг → включить 50% → playground → demo-shop видит изменение |
| Bench | evaluator, регрессии в PR |

## Сценарий видео (90 сек)
1. Demo-shop, debug-панель: `new-checkout = false`.
2. Dashboard: добавить правило `plan = pro → true`, поднять fallthrough до 25%, Save.
3. Demo-shop **без перезагрузки** переключается (< 1 сек). Переключить пользователя на `pro`, увидеть reason `RULE_MATCH`.
4. Playground: вставить контекст, увидеть объяснение.
5. Experiments: результаты с CI и lift, SRM ok.
6. Терминал: `npm i @scope/flags-node` + 5 строк кода, флаг оценён.
7. Бенчмарк-таблица: «3 µs per evaluation, 0 network calls».

## Highlights для README (EN)
- Deterministic, cross-platform bucketing verified by 150 shared conformance vectors
- Local evaluation in ~3 µs, 0 network calls; updates are streamed via SSE in < 1 s
- Client-side SDK never receives targeting rules, only evaluated values (privacy by design)
- OpenFeature-compatible providers, so it can replace an existing vendor without changing app code
- Experiments with a z-test, confidence intervals and sample ratio mismatch detection
- Published on npm with provenance, dual ESM/CJS, typed, 4.1 KB gzip web SDK
