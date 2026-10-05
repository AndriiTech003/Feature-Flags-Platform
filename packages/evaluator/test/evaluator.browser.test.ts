import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashVectors, registerConformanceSuite } from '@ffp/conformance';
import { murmurhash3 } from '../src';
import { evaluatorAdapter } from './adapter';

describe('murmurhash3 in the browser', () => {
  it('matches every hash vector', () => {
    for (const vector of hashVectors) expect(murmurhash3(vector.input)).toBe(vector.hash);
  });
  it('runs in a real browser', () => {
    expect(typeof window).toBe('object');
    expect(navigator.userAgent).toMatch(/Chrome|Firefox|Safari|AppleWebKit/);
  });
});

registerConformanceSuite(evaluatorAdapter('evaluator (browser)'), {
  describe,
  it,
  beforeAll,
  afterAll,
  expect,
});
