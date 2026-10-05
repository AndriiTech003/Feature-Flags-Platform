# @ashamrai/flags-node-redis

Redis `PersistentStore` for `@ashamrai/flags-node`. The SDK saves every ruleset it receives; after a restart without access to the relay it serves the last known flags instead of defaults.

```sh
npm i @ashamrai/flags-node-redis ioredis
```

```ts
import { Redis } from 'ioredis';
import { init } from '@ashamrai/flags-node';
import { RedisPersistentStore } from '@ashamrai/flags-node-redis';

const flags = init({
  sdkKey: process.env.FLAGS_SDK_KEY!,
  persistentStore: new RedisPersistentStore({
    client: new Redis(process.env.REDIS_URL!),
    prefix: 'flags:',
    ttlSeconds: 7 * 86400,
  }),
});
```

Any client with `get(key)` and `set(key, value[, 'EX', seconds])` works. MIT licensed.
