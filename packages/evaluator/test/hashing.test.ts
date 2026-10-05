import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { hashVectors } from '@ffp/conformance';
import { BUCKET_COUNT, bucketFor, bucketInput, murmurhash3, murmurhash3Bytes, utf8Bytes } from '../src';

describe('murmurhash3_x86_32', () => {
  for (const vector of hashVectors) {
    it(`hashes ${JSON.stringify(vector.input.slice(0, 40))} (${vector.input.length} chars)`, () => {
      expect(murmurhash3(vector.input)).toBe(vector.hash);
      expect(murmurhash3(vector.input) % BUCKET_COUNT).toBe(vector.bucket);
    });
  }

  it('matches published reference values', () => {
    expect(murmurhash3('')).toBe(0);
    expect(murmurhash3('hello')).toBe(0x248bfa47);
    expect(murmurhash3('The quick brown fox jumps over the lazy dog')).toBe(0x2e4ff723);
  });

  it('supports a custom seed', () => {
    expect(murmurhash3('', 1)).toBe(0x514e28b7);
    expect(murmurhash3Bytes(new Uint8Array([0x21, 0x43, 0x65, 0x87]), 4, 0)).toBe(0xf55b516b);
  });

  it('encodes UTF-8 exactly like TextEncoder, including lone surrogates', () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (input) => {
        expect(Array.from(utf8Bytes(input))).toEqual(Array.from(encoder.encode(input)));
      }),
      { numRuns: 2000 },
    );
    expect(Array.from(utf8Bytes('\ud800x'))).toEqual(Array.from(encoder.encode('\ud800x')));
    expect(Array.from(utf8Bytes('x\udc00'))).toEqual(Array.from(encoder.encode('x\udc00')));
  });

  it('hashes strings via the byte path consistently', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 64 }), (input) => {
        const bytes = new TextEncoder().encode(input);
        expect(murmurhash3(input)).toBe(murmurhash3Bytes(bytes));
      }),
      { numRuns: 1000 },
    );
  });

  it('builds the bucket input from flag key, salt and bucket key', () => {
    expect(bucketInput('f', 's', 'k')).toBe('f.s.k');
    expect(bucketFor('f', 's', 'k')).toBe(murmurhash3('f.s.k') % BUCKET_COUNT);
  });
});
