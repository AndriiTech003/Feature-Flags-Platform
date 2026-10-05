# @ashamrai/flags-openfeature-web

OpenFeature web provider backed by `@ashamrai/flags-web`. Values are resolved synchronously from the values the relay evaluated for the current context.

```sh
npm i @ashamrai/flags-openfeature-web @openfeature/web-sdk
```

```ts
import { OpenFeature } from '@openfeature/web-sdk';
import { WebFlagsProvider } from '@ashamrai/flags-openfeature-web';

await OpenFeature.setContext({ targetingKey: 'anon-123' });
await OpenFeature.setProviderAndWait(
  new WebFlagsProvider({ clientKey: 'cli-…', baseUrl: 'https://relay.example.dev' }),
);
OpenFeature.getClient().getStringValue('banner-text', 'Welcome');
await OpenFeature.setContext({ targetingKey: user.id, plan: 'pro' }); // onContextChange re-evaluates on the relay
```

Reason and error mapping is the same as in `@ashamrai/flags-openfeature-node`. MIT licensed.
