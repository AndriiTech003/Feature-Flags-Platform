import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
    redisPrefix: string;
  }
}
