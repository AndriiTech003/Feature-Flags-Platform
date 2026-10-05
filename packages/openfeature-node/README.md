# @ashamrai/flags-openfeature-node

OpenFeature server provider backed by `@ashamrai/flags-node`. Replace another vendor's provider without changing application code.

```sh
npm i @ashamrai/flags-openfeature-node @openfeature/server-sdk
```

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { FlagsProvider } from '@ashamrai/flags-openfeature-node';

await OpenFeature.setProviderAndWait(new FlagsProvider({ sdkKey: process.env.FLAGS_SDK_KEY! }));
const client = OpenFeature.getClient();
await client.getBooleanValue('new-checkout', false, { targetingKey: user.id, plan: 'pro' });
```

**Context mapping.** `targetingKey` becomes `key`; a `kind` attribute selects the context kind; nested objects with a `key` (for example `organization: { key: 'acme' }`) become a multi-context.

**Reasons and errors.** `TARGET_MATCH`/`RULE_MATCH` → `TARGETING_MATCH`, rollouts in an experiment → `SPLIT`, `FALLTHROUGH` → `DEFAULT`, `OFF`/`PREREQUISITE_FAILED` → `DISABLED`; `FLAG_NOT_FOUND`, `WRONG_TYPE` → `TYPE_MISMATCH`, `INVALID_CONTEXT`/`TARGETING_KEY_MISSING`, `MALFORMED_FLAG` → `PARSE_ERROR`, `CLIENT_NOT_READY` → `PROVIDER_NOT_READY`. Rule id, rule index and `inExperiment` are exposed as flag metadata.

**Events.** `PROVIDER_READY`, `PROVIDER_CONFIGURATION_CHANGED` (with `flagsChanged`), `PROVIDER_STALE` while the stream is down, `PROVIDER_ERROR` when initialization fails. `client.track()` is forwarded as a custom event.

MIT licensed.
