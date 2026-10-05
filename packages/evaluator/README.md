# @ashamrai/flags-evaluator

Pure, dependency-free feature flag evaluation core. Runs unchanged in Node.js, browsers and edge runtimes (Cloudflare Workers, Deno).

- Deterministic bucketing: `murmurhash3_x86_32(UTF-8("flagKey.salt.bucketKey")) % 100000`, so a user lands in the same variation on the server, in the browser and in every SDK.
- Every operator (`in`, `not_in`, `eq`, `neq`, `contains`, `starts_with`, `ends_with`, `matches`, `lt`/`lte`/`gt`/`gte`, `semver_*`, `before`/`after`, `segment_match`), multi-contexts, segments, prerequisites with cycle detection.
- Never throws: errors become `{ reason: { kind: 'ERROR', errorKind } }` and the default value.
- Verified by the shared conformance vectors (185 cases) in Node and in Chromium.

## Install

```sh
npm i @ashamrai/flags-evaluator
```

## Quick start

```ts
import { createStore, evaluateFlag } from '@ashamrai/flags-evaluator';

const store = createStore(ruleset);
const detail = evaluateFlag(
  store,
  'new-checkout',
  { kind: 'user', key: 'u-42', plan: 'pro' },
  { defaultValue: false, expectedKind: 'boolean' },
);
// { value: true, variationId: 'on', reason: { kind: 'RULE_MATCH', ruleIndex: 0, ruleId: 'pro-users' } }
```

## API

| Export                                                                   | Description                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `evaluate(flag, config, context, store, { defaultValue, expectedKind })` | Evaluate one flag.                                                          |
| `evaluateFlag(store, key, context, options)`                             | Look up and evaluate a flag by key.                                         |
| `evaluateAll(flags, store, context, { clientSideOnly, withReasons })`    | Evaluate every flag for one context (used for SSR bootstrap and the relay). |
| `createStore(ruleset)`                                                   | Wrap `{ flags, segments }` into an evaluation store.                        |
| `murmurhash3(input, seed?)`, `bucketFor(flagKey, salt, key)`             | Hashing and bucketing primitives.                                           |
| `parseSemver`, `compareSemver`, `semverCompare`                          | Small semver 2.0.0 implementation.                                          |

Reasons: `OFF`, `TARGET_MATCH`, `RULE_MATCH { ruleIndex, ruleId, inExperiment? }`, `FALLTHROUGH { inExperiment? }`, `PREREQUISITE_FAILED { prerequisiteKey }`, `ERROR { errorKind: FLAG_NOT_FOUND | MALFORMED_FLAG | WRONG_TYPE | INVALID_CONTEXT | EXCEPTION }`.

## Performance

Apple M1, Node 26: off flag 0.07 µs, 5 rules × 3 clauses 0.38 µs, 50/50 rollout 0.23 µs, 1000-key segment 0.11 µs, regex clause 0.13 µs. Run `pnpm bench` in the repository.

## FAQ

**Why UTF-8 bytes and not JS string code units?** Browsers and servers must agree on the bucket of `"Київ"` or `"😀"`. Hashing UTF-16 code units would be faster but other languages' SDKs hash bytes; the conformance vectors pin the exact values.

**Is `matches` safe against ReDoS?** Patterns longer than 256 characters, nested quantifiers like `(a+)+` and backreferences are rejected, inputs longer than 4096 characters never match, and compiled patterns are cached.

MIT licensed.
