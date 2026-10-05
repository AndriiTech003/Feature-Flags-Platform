# @ashamrai/flags-react

React bindings for `@ashamrai/flags-web`.

```sh
npm i @ashamrai/flags-react @ashamrai/flags-web
```

```tsx
import { createClient } from '@ashamrai/flags-web';
import { FlagsProvider, useFlag, useFlagDetail } from '@ashamrai/flags-react';

const client = createClient({ clientKey: 'cli-…', context: { kind: 'user', key: 'anon-1' } });

<FlagsProvider client={client}>
  <App />
</FlagsProvider>;

function Checkout() {
  const showNew = useFlag('new-checkout', false);
  const { value, reason } = useFlagDetail('banner-text', 'Welcome');
}
```

- Subscriptions use `useSyncExternalStore`, so concurrent rendering never tears.
- Subscriptions are per flag key: a change of `banner-text` re-renders only components that read `banner-text`.
- SSR: `<FlagsProvider bootstrap={allFlagsState}>` renders on the server without a client.

MIT licensed.
