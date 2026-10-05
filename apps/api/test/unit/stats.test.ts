import { describe, expect, it } from 'vitest';
import {
  chiSquareSurvival,
  normalCdf,
  normalQuantile,
  sampleRatioMismatch,
  sampleSizePerVariation,
  studentTCdf,
  studentTQuantile,
  twoProportionZTest,
  welchTTest,
} from '../../src/experiments/stats';

describe('distributions', () => {
  it('normal cdf and quantile agree with tables', () => {
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 4);
  });

  it('student t cdf and quantile agree with tables', () => {
    expect(studentTCdf(2.228, 10)).toBeCloseTo(0.975, 3);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228139, 4);
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.7062, 3);
    expect(studentTCdf(-1, 5)).toBeCloseTo(0.181609, 5);
  });

  it('chi-square survival agrees with tables', () => {
    expect(chiSquareSurvival(3.841459, 1)).toBeCloseTo(0.05, 5);
    expect(chiSquareSurvival(134.642, 99)).toBeCloseTo(0.01, 3);
    expect(chiSquareSurvival(13.8155, 2)).toBeCloseTo(0.001, 5);
    expect(chiSquareSurvival(0, 3)).toBe(1);
  });
});

describe('two proportion z-test', () => {
  it('matches a hand computed example', () => {
    const result = twoProportionZTest(200, 1000, 250, 1000);
    expect(result.difference).toBeCloseTo(0.05, 10);
    expect(result.relativeLift).toBeCloseTo(0.25, 10);
    expect(result.z).toBeCloseTo(2.6774, 3);
    expect(result.pValue).toBeCloseTo(0.00742, 4);
    expect(result.ciLow).toBeCloseTo(0.0136, 3);
    expect(result.ciHigh).toBeCloseTo(0.0864, 3);
    expect(result.significant).toBe(true);
  });

  it('is not significant for identical groups and handles empty input', () => {
    expect(twoProportionZTest(100, 1000, 100, 1000).pValue).toBeCloseTo(1, 6);
    expect(twoProportionZTest(0, 0, 0, 0).significant).toBe(false);
  });
});

describe('welch t-test', () => {
  it('matches an independent computation for a known example', () => {
    const control = [19.8, 20.4, 19.6, 17.8, 18.5, 18.9, 18.3, 18.9, 19.5, 22.0];
    const treatment = [
      28.2, 26.6, 20.1, 23.3, 25.2, 22.1, 17.7, 27.6, 20.6, 13.7, 23.2, 17.5, 20.6, 18.0, 23.9, 21.6, 24.3,
      20.4, 23.9, 13.3,
    ];
    const summary = (xs: number[]) => {
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      return { n: xs.length, mean, variance: xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1) };
    };
    const result = welchTTest(summary(control), summary(treatment));
    expect(result.t).toBeCloseTo(2.22551, 4);
    expect(result.df).toBeCloseTo(24.5246, 3);
    expect(result.pValue).toBeCloseTo(0.035485, 4);
    expect(result.significant).toBe(true);
  });

  it('degrades gracefully with too few samples', () => {
    expect(welchTTest({ n: 1, mean: 1, variance: 0 }, { n: 1, mean: 2, variance: 0 }).pValue).toBe(1);
  });
});

describe('sample ratio mismatch', () => {
  it('flags a broken split and accepts a healthy one', () => {
    expect(sampleRatioMismatch([5000, 5020], [50, 50]).mismatch).toBe(false);
    const broken = sampleRatioMismatch([5000, 5600], [50, 50]);
    expect(broken.mismatch).toBe(true);
    expect(broken.pValue).toBeLessThan(0.001);
    expect(sampleRatioMismatch([0, 0], [1, 1]).mismatch).toBe(false);
    expect(sampleRatioMismatch([3333, 3300, 3367], [33333, 33333, 33334]).degreesOfFreedom).toBe(2);
  });
});

describe('sample size', () => {
  it('matches the standard formula', () => {
    expect(sampleSizePerVariation(0.1, 0.2)).toBeGreaterThan(3800);
    expect(sampleSizePerVariation(0.1, 0.2)).toBeLessThan(3900);
    expect(sampleSizePerVariation(0.3, 0.08, 0.05, 0.8, 3)).toBeGreaterThan(
      sampleSizePerVariation(0.3, 0.08),
    );
  });
});
