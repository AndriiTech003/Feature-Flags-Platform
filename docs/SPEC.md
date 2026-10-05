# SPEC · Feature Flags Platform

## 1. Доменная модель

```text
Organization
 └── Project (например "web-shop")
      ├── Environments: development, staging, production (+ свои)
      │     └── SDK keys: server key (srv-…), client key (cli-…)
      ├── Flags (определение общее для проекта, конфигурация — на окружение)
      │     └── FlagConfig[env]: on/off, targets, rules, fallthrough, offVariation, version
      ├── Segments (на окружение): переиспользуемые группы пользователей
      ├── Metrics (для экспериментов): событие + тип (conversion / numeric)
      └── Experiments: flag + env + metrics + период
```

### Flag

```ts
type Flag = {
  key: string;                       // "new-checkout", ^[a-z0-9][a-z0-9-_.]{0,63}$
  name: string;
  description?: string;
  kind: 'boolean' | 'string' | 'number' | 'json';
  variations: Array<{ id: string; value: unknown; name?: string }>;  // boolean: [true, false]
  tags: string[];
  temporary: boolean;                // временный флаг → подсказки «пора удалить»
  maintainerId?: string;
  prerequisites?: Array<{ flagKey: string; variationId: string }>;
  salt: string;                      // случайный при создании, участвует в хэше
  archivedAt?: string;
};

type FlagConfig = {                  // на окружение
  flagKey: string;
  env: string;
  on: boolean;
  offVariation: string;              // variation id, когда флаг выключен
  targets: Array<{ variation: string; contextKind: string; keys: string[] }>;  // индивидуальный таргетинг
  rules: Rule[];                     // по порядку, первое совпадение побеждает
  fallthrough: Serve;                // если ни одно правило не подошло
  version: number;                   // инкремент на каждое изменение
  updatedAt: string;
};

type Rule = {
  id: string;
  description?: string;
  clauses: Clause[];                 // AND
  serve: Serve;
};

type Clause = {
  attribute: string;                 // "country", "plan", "email", "user.createdAt", "segment"
  contextKind?: string;              // "user" (по умолчанию), "organization", "device"
  op: 'in' | 'not_in' | 'eq' | 'neq' | 'contains' | 'starts_with' | 'ends_with' | 'matches'
    | 'lt' | 'lte' | 'gt' | 'gte'
    | 'semver_eq' | 'semver_lt' | 'semver_gt'
    | 'before' | 'after'
    | 'segment_match';
  values: unknown[];                 // OR внутри clause
  negate?: boolean;
};

type Serve =
  | { variation: string }
  | { rollout: { bucketBy?: string; contextKind?: string; weights: Array<{ variation: string; weight: number }> } };
  // weights в сотых долях процента, сумма = 100000 (т.е. шаг 0.001%)
```

### Context (кого оцениваем)

Мульти-контекст, как в современных системах:

```ts
type Context =
  | { kind: 'user'; key: string; [attr: string]: unknown }
  | { kind: 'multi'; user?: {...}; organization?: {...}; device?: {...} };
```

Это позволяет раскатывать фичу **по организациям** (все пользователи компании одновременно). Для B2B важно, и на интервью это хорошая тема.

### Segment

```ts
type Segment = {
  key: string;
  included: string[];               // явные ключи
  excluded: string[];
  rules: Array<{ clauses: Clause[] }>;   // OR между правилами, AND внутри
  version: number;
};
```

Большие списки (> 10 000 ключей) хранятся отдельно и отдаются SDK как bloom-фильтр или через server-side оценку. В MVP это ограничение (лимит), а в «Known limitations» описан путь решения.

---

## 2. Алгоритм оценки (`packages/evaluator`)

```text
evaluate(flag, config, context, store) → { value, variationId, reason }

1. Флаг не найден                       → default, reason: ERROR(FLAG_NOT_FOUND)
2. config.on == false                   → offVariation, reason: OFF
3. Prerequisites: для каждого — рекурсивно evaluate;
   если результат ≠ требуемой вариации  → offVariation, reason: PREREQUISITE_FAILED(key)
   (защита от циклов: стек посещённых ключей → ERROR(MALFORMED_FLAG))
4. Individual targets: key контекста в списке → variation, reason: TARGET_MATCH
5. Rules по порядку: все clauses совпали → serve(rule), reason: RULE_MATCH(ruleIndex, ruleId)
6. Fallthrough                          → serve(fallthrough), reason: FALLTHROUGH
+ inExperiment: true, если serve был rollout и флаг в активном эксперименте
```

Требования к `evaluator`:
- Чистые функции, без I/O, **0 зависимостей**, работает в Node, браузере, edge (Cloudflare Workers).
- Никогда не бросает исключений наружу, ошибки превращаются в `reason: ERROR(kind)` и default.
- Ошибка типа (вариация `string`, а запрошен `boolean`) → `ERROR(WRONG_TYPE)`.
- `matches` (regex): кэш скомпилированных выражений, защита от ReDoS (ограничение длины шаблона и входа, или библиотека `re2` на сервере с fallback).
- Семвер-сравнение — своя маленькая реализация (без зависимостей), покрыта тестами.

### Бакетинг (детерминированный)

```text
bucketKey  = context[bucketBy] (по умолчанию key выбранного contextKind)
input      = `${flag.key}.${flag.salt}.${bucketKey}`
hash       = murmurhash3_x86_32(input, seed = 0)            // своя реализация, одинаковая везде
bucket     = hash % 100000                                   // 0..99999

накопленная сумма весов: [variation A: 0..9999], [B: 10000..99999]
bucket попадает в интервал → вариация
```

Свойства (у каждого есть тест):
- **Монотонность:** увеличение веса варианта A только добавляет пользователей в A, не перемешивает остальных. Тест: 100k случайных ключей, 10% → 20%, все из первой группы остаются в A.
- **Равномерность:** χ²-тест распределения 1M ключей по 100 корзинам, p > 0.01.
- **Независимость флагов:** корреляция попадания в два флага с разным salt ≈ 0.
- **Кросс-платформенная идентичность:** test vectors с заранее посчитанными bucket'ами для конкретных ключей (включая unicode, пустую строку, очень длинные строки). Unicode хэшируется по UTF-8 байтам, иначе браузер и Node разойдутся (`TextEncoder`). Хорошая деталь для ADR.

### Conformance test vectors (`packages/conformance/vectors/*.json`)

```json
{
  "name": "percentage rollout 30/70 by organization",
  "flags": [ { … } ],
  "segments": [ … ],
  "cases": [
    { "context": { "kind": "multi", "user": {"key":"u1"}, "organization": {"key":"acme"} },
      "expect": { "variationId": "on", "reason": { "kind": "FALLTHROUGH", "inExperiment": true } } }
  ]
}
```

~150 кейсов: каждый оператор, prerequisites, циклы, targets, segments, multi-context, отсутствующие атрибуты, неправильные типы, unicode. Один раннер прогоняется в CI для `evaluator`, `sdk-node`, `sdk-web` (в браузере через Vitest browser mode / Playwright) и для server-side evaluation в `relay`.

---

## 3. Серверная часть

### API (NestJS, `apps/api`) — управление

| Метод | Путь | Описание |
|---|---|---|
| POST | `/auth/*` | Пользователи дашборда (email + пароль, опционально GitHub OAuth) |
| CRUD | `/projects`, `/projects/:p/environments` | |
| CRUD | `/projects/:p/flags` | Определение флага |
| GET | `/projects/:p/flags/:key/envs/:env` | Конфиг в окружении |
| PATCH | `/projects/:p/flags/:key/envs/:env` | **Семантический патч**: массив инструкций (`turnOn`, `addRule`, `updateRuleClauses`, `reorderRules`, `updateFallthrough`, `addTargets`…) + `If-Match: version` → 409 при конфликте |
| POST | `/projects/:p/flags/:key/envs/:env/change-requests` | Для prod с обязательным ревью |
| POST | `/change-requests/:id/approve` / `apply` | |
| POST | `/projects/:p/flags/:key/envs/:env/schedule` | Отложенные изменения («в пятницу 10:00 поднять до 50%») |
| CRUD | `/projects/:p/envs/:env/segments` | |
| POST | `/projects/:p/flags/:key/copy` | Скопировать конфиг staging → production (с diff-превью) |
| GET | `/projects/:p/audit-log` | С diff |
| GET | `/projects/:p/flags/:key/insights` | Сколько оценок по вариациям за 24 ч / 7 дн, последний раз оценён (для поиска мёртвых флагов) |
| CRUD | `/projects/:p/metrics`, `/experiments` | |
| GET | `/experiments/:id/results` | |
| CRUD | `/projects/:p/envs/:env/sdk-keys` | Ротация ключей с периодом, когда старый ещё действует |
| CRUD | `/webhooks` | Уведомления об изменениях флагов (Slack-совместимый payload) |

Семантический патч вместо PUT всего конфига нужен, чтобы два человека, меняющие разные правила, не перетирали изменения друг друга, а в аудите было видно намерение («added rule: country in [DE]»), а не «конфиг изменён».

### Relay (`apps/relay`, Fastify) — раздача SDK

| Метод | Путь | Для кого | Ответ |
|---|---|---|---|
| GET | `/sdk/v1/ruleset` | server key | Все флаги и сегменты окружения, `ETag: "<env-version>"`, 304 при совпадении |
| GET | `/sdk/v1/stream` | server key | SSE: `event: put` (полный ruleset при подключении), `event: patch` (изменённый флаг или сегмент), `:heartbeat` каждые 15 сек |
| POST | `/sdk/v1/evaluate` | client key | Тело: context → `{ flags: { key: {value, variationId, reason?} } }` только для флагов с `clientSideAvailable` |
| GET | `/sdk/v1/client-stream?ctx=<base64>` | client key | SSE с переоценёнными значениями при изменениях |
| POST | `/sdk/v1/events` | оба | Батч событий экспозиции и кастомных событий (для экспериментов) |

Почему клиентский SDK **не** получает все правила: правила могут содержать email-адреса, названия внутренних сегментов, ещё не анонсированные фичи. Браузер получает только результат для своего контекста. Это ADR.

Как relay узнаёт об изменениях: API после коммита публикует `flag.changed {env, flagKey, version}` в Redis pub/sub. Relay держит ruleset окружения в памяти, обновляет его и рассылает `patch` всем SSE-подписчикам окружения. Relay можно масштабировать горизонтально, каждый инстанс подписан на Redis.

Масштаб SSE: одно соединение на инстанс SDK (а не на пользователя). У клиентского SDK — одно на вкладку браузера. Ориентир — тысячи соединений на инстанс relay; метрика числа соединений выводится.

### Данные (PostgreSQL)

```sql
organizations(id, name)
users(id, email, password_hash, name)
org_members(org_id, user_id, role)                 -- admin | writer | reader
projects(id, org_id, key, name)
environments(id, project_id, key, name, color, require_approval bool, version bigint)  -- version++ на любое изменение
sdk_keys(id, env_id, kind, key_hash, prefix, expires_at, created_at)
flags(id, project_id, key, name, description, kind, variations jsonb, tags text[], temporary, salt, prerequisites jsonb, client_side_available bool, archived_at)
flag_configs(flag_id, env_id, on bool, off_variation, targets jsonb, rules jsonb, fallthrough jsonb, version int, updated_at, updated_by)
segments(id, env_id, key, name, included text[], excluded text[], rules jsonb, version)
change_requests(id, flag_id, env_id, instructions jsonb, status, author_id, reviewer_id, base_version, created_at, applied_at)
scheduled_changes(id, flag_id, env_id, instructions jsonb, execute_at, status)
audit_log(id, org_id, project_id, env_id, actor_id, action, resource, before jsonb, after jsonb, instructions jsonb, created_at)
metrics(id, project_id, key, event_key, kind, unit)
experiments(id, project_id, env_id, flag_id, metric_ids uuid[], started_at, ended_at, status)
webhooks(id, org_id, url, secret, events text[])
```

- Правила хранятся в JSONB и валидируются zod при записи. Ruleset для SDK собирается одним запросом и кэшируется по `environments.version`.
- Scheduled changes исполняет воркер: `SELECT … WHERE execute_at <= now() FOR UPDATE SKIP LOCKED`.

### События экспозиции и эксперименты

- SDK отправляет `exposure {flagKey, variationId, contextKey, inExperiment, ts}` с **дедупликацией на стороне SDK** (LRU-кэш «уже отправляли эту пару контекст+флаг+вариация за последний час»), чтобы не отправлять миллионы одинаковых событий.
- Кастомные события: `track('purchase', context, { value: 49.9 })`.
- Хранение: для MVP Postgres (партиционированная таблица по дням) или ClickHouse, если хочется повторить стек. В этом проекте разумно взять **Postgres** и показать партиционирование (`PARTITION BY RANGE (ts)`, `pg_partman` или свой скрипт).
- Результаты эксперимента:
  - Conversion-метрика: доля конвертировавшихся по вариантам, **двухпропорциональный z-тест**, 95% CI для разницы, относительный lift.
  - Numeric-метрика: среднее, Welch t-test.
  - Предупреждение **SRM** (sample ratio mismatch): χ² фактического сплита против ожидаемого весов. Если p < 0.001, выводится предупреждение «эксперимент может быть сломан». Это деталь, которая сразу выдаёт человека, понимающего эксперименты.
  - Предупреждение о «подглядывании» (peeking) и заранее заданном размере выборки: калькулятор MDE → нужное число пользователей.
- Атрибуция: событие метрики учитывается, если произошло после первой экспозиции этого контекста в эксперименте.

---

## 4. Dashboard (React + Vite)

Стек: React 19, Vite, TanStack Router (типизированные роуты), TanStack Query, shadcn/ui, react-hook-form + zod. **Не Next.js**: это SPA-дашборд, и так он отличается стеком от флагмана.

Экраны:
1. **Flags list**: поиск, фильтры (tags, temporary, stale), для каждого окружения мини-переключатели on/off и индикатор «не оценивался 30 дней».
2. **Flag detail** (по окружениям во вкладках):
   - Kill switch (крупный on/off с подтверждением в prod).
   - Individual targets.
   - Редактор правил: drag-n-drop порядок, конструктор clauses с автодополнением атрибутов (собранных из контекстов, которые видел relay), слайдер процентов с визуализацией распределения.
   - Fallthrough, off variation.
   - **Pending changes bar**: изменения копятся локально, внизу видны diff и кнопка «Review & save» (или «Request approval» в prod).
   - **Evaluate playground**: ввести JSON контекста → увидеть результат и объяснение reason (какое правило сработало). Использует тот же `packages/evaluator` в браузере.
   - Insights: график оценок по вариациям.
3. **Compare environments**: таблица флаг × окружение, diff конфигов, «copy staging → prod».
4. **Segments**.
5. **Experiments**: результаты с CI, lift, SRM-предупреждение, калькулятор размера выборки.
6. **Change requests** (ревью с diff), **Scheduled changes**, **Audit log** с фильтрами.
7. **SDK keys**, **Webhooks**, **Members**.

Realtime в дашборде: если флаг изменил другой пользователь, показывается баннер «Flag was updated by X — reload» (SSE из API).

---

## 5. Demo-shop (`apps/demo-shop`)

Маленький Next.js- или Express-сайт, который реально использует SDK:
- `new-checkout` (boolean, 25% rollout) — другая страница оформления;
- `banner-text` (string, эксперимент на 3 варианта);
- `max-cart-items` (number, remote config);
- `pricing-page-layout` (json).

На экране демо-магазина — debug-панель: текущий контекст, значения флагов, reason. Изменение флага в дашборде отражается в демо-магазине **меньше чем за секунду без перезагрузки**. Это главный момент видео.

Скрипт-генератор трафика для demo-shop, чтобы в экспериментах были данные (с заложенным эффектом: вариант B конвертирует на 8% лучше, и эксперимент это находит).
