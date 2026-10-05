import { murmurhash3 } from './murmurhash';

export const BUCKET_COUNT = 100000;

export function bucketInput(flagKey: string, salt: string, bucketKey: string): string {
  return `${flagKey}.${salt}.${bucketKey}`;
}

export function bucketFor(flagKey: string, salt: string, bucketKey: string): number {
  return murmurhash3(bucketInput(flagKey, salt, bucketKey)) % BUCKET_COUNT;
}
