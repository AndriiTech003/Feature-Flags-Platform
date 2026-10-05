# SDK · Дизайн, API, публикация

## Принципы

1. **Никогда не ломать приложение.** Любая ошибка SDK превращается в default-значение и лог через переданный logger. Исключение бросается только при неверной конфигурации в `init` (и то опционально).
2. **Быстрая локальная оценка** (server SDK): 0 сетевых вызовов на `variation()`. Цель — < 5 µs на флаг с 5 правилами (бенчмарк в CI).
3. **Предсказуемый жизненный цикл:** `init → waitForInitialization(timeout) → use → close()`.
4. **Минимальный размер** (web SDK): ≤ 5 KB gzip без React-обёртки (`size-limit` в CI).
5. **Типобезопасность:** опциональная генерация типов флагов из API (`npx @scope/flags-cli codegen`) → `client.variation('new-checkout')` знает, что возвращается `boolean`.

## `@scope/flags-node`

```ts
import { init } from '@scope/flags-node';

const flags = init({
  sdkKey: process.env.FLAGS_SDK_KEY!,
  baseUrl: 'https://relay.example.dev',   // по умолчанию — хостинг демо
  stream: true,                           // SSE; false → polling
  pollIntervalMs: 30_000,
  events: { flushIntervalMs: 5_000, capacity: 10_000 },
  bootstrap: rulesetFromFile,             // офлайн / тесты
  logger: pinoLogger,                     // интерфейс {debug, info, warn, error}
});

await flags.waitForInitialization({ timeoutMs: 3000 });   // не бросает, возвращает статус

const on = flags.boolVariation('new-checkout', { kind: 'user', key: user.id, plan: user.plan }, false);
const detail = flags.boolVariationDetail('new-checkout', ctx, false); // { value, variationId, reason }
const all = flags.allFlagsState(ctx, { clientSideOnly: true });       // для SSR → bootstrap web SDK
flags.track('purchase', ctx, { value: 49.9 });
flags.on('update', ({ key }) => …);                                   // флаг изменился
flags.on('error', err => …);
await flags.flush();
await flags.close();
```

Внутри:
- **Data source**: SSE-клиент (свой поверх `fetch` + `ReadableStream`, без зависимостей) с reconnect (экспоненциальный backoff 1s → 30s + jitter), обработкой `put` / `patch`, детектом зависания по отсутствию heartbeat (> 45 сек → переподключение). Fallback на polling с ETag.
- **Store**: in-memory ruleset + версия. Интерфейс `PersistentStore` (опционально Redis-реализация в отдельном пакете `@scope/flags-node-redis`), чтобы при рестарте без доступа к relay были последние значения.
- **Event processor**: буфер с лимитом (при переполнении старые события отбрасываются + счётчик), дедуп экспозиций (LRU 1h), батч-отправка, ретрай один раз, `flush()` на `beforeExit` / `close()`.
- **Diagnostics**: раз в 15 минут отправляются init time, число переподключений, размер очереди событий, версия SDK.
- Потребление ресурсов: тест на утечки — 1M оценок и 1000 patch-обновлений, heap стабилен.

## `@scope/flags-web`

```ts
import { createClient } from '@scope/flags-web';

const client = createClient({
  clientKey: 'cli-…',
  context: { kind: 'user', key: 'anon-123' },
  bootstrap: window.__FLAGS__,     // значения из SSR (allFlagsState) → нет мигания интерфейса
  stream: true,                    // SSE с переоценкой при изменениях
});

await client.ready();
client.variation('banner-text', 'Welcome');
await client.identify({ kind: 'user', key: user.id, plan: 'pro' });  // переоценка на сервере
client.on('change', (changes) => …);
```

- Кэш последних значений в `localStorage` по хэшу контекста → мгновенный старт при повторном визите.
- Отправка событий через `sendBeacon` при `visibilitychange=hidden`.
- Экспозиция засчитывается при **вызове** `variation()`, а не при загрузке. Это важно для корректности экспериментов, в документации SDK объясняется почему.

## `@scope/flags-react`

```tsx
<FlagsProvider client={client}>
  <App />
</FlagsProvider>

const showNew = useFlag('new-checkout', false);
const { value, reason } = useFlagDetail('banner-text', 'Welcome');
```

- `useSyncExternalStore` для подписки: корректно работает с concurrent rendering, без tearing.
- Ре-рендер только компонентов, чьи флаги изменились (подписка по ключу).
- Поддержка SSR (Next.js): провайдер принимает bootstrap.

## OpenFeature providers

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { FlagsProvider } from '@scope/flags-openfeature-node';

await OpenFeature.setProviderAndWait(new FlagsProvider({ sdkKey }));
const client = OpenFeature.getClient();
await client.getBooleanValue('new-checkout', false, { targetingKey: user.id, plan: 'pro' });
```

- Маппинг `EvaluationContext` → Context (`targetingKey` → `key`, вложенные объекты → multi-context по соглашению).
- Маппинг reasons и error codes на стандарт OpenFeature.
- Events: `PROVIDER_READY`, `PROVIDER_CONFIGURATION_CHANGED`, `PROVIDER_ERROR`, `PROVIDER_STALE`.
- Прогон официального набора тестов OpenFeature, если он доступен для провайдеров, или собственного набора по спецификации.

Совместимость с OpenFeature позволяет написать в README: «можно заменить LaunchDarkly на этот провайдер без изменения кода приложения». Для работодателя это понятная ценность.

## `@scope/flags-cli` (опционально, M4)

- `flags login`, `flags codegen --project web-shop --out src/flags.gen.ts` — генерация типов флагов.
- `flags find-stale` — ищет в коде ключи флагов, которые архивированы или не оценивались 30 дней (простой grep по AST или regex). Полезная «инженерная гигиена», хорошо смотрится.

---

## Публикация в npm

- **Сборка:** `tsup` → ESM + CJS + `.d.ts`, поле `exports` с условиями `import` / `require` / `types`, `sideEffects: false`.
- **Проверки:** `publint` + `@arethetypeswrong/cli` в CI (правильность exports и типов), `size-limit`.
- **Версионирование:** Changesets. PR с changeset → бот открывает «Version Packages» PR → merge → публикация.
- **Provenance:** `npm publish --provenance` из GitHub Actions (OIDC), значок «Built and signed on GitHub Actions» на npm.
- **Документация:** README каждого пакета (установка, быстрый старт, API, FAQ), TypeDoc → GitHub Pages.
- **Совместимость:** матрица CI Node 20 / 22 / 24; браузерные тесты в Chromium, Firefox, WebKit (Playwright).
- **Лицензия:** MIT.
- **Semver:** до 1.0 — `0.x`; после стабилизации API — `1.0.0` с явной политикой поддержки в README.

## Бенчмарки (`packages/evaluator/bench`, tinybench)

| Кейс | Цель |
|---|---|
| boolean flag, off | < 0.3 µs |
| 5 правил, 3 clauses, совпадение в последнем | < 5 µs |
| rollout 50/50 (murmurhash) | < 1 µs |
| segment с 1000 included ключей (Set) | < 1 µs |
| regex clause | < 3 µs |

Результаты — таблица в README с окружением (CPU, Node version). В CI бенчмарк сравнивается с main, регрессия > 25% → комментарий в PR.
