import { describe, expect, it } from 'vitest';
import { compareSemver, parseSemver, semverCompare } from '../src';

describe('semver', () => {
  it('parses full and partial versions', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('1')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [] });
    expect(parseSemver('1.2-rc.1+meta')).toEqual({ major: 1, minor: 2, patch: 0, prerelease: ['rc', 1] });
  });

  it('rejects invalid input', () => {
    for (const bad of [
      '',
      'v1.2.3',
      '1.2.3.4',
      '01.2.3',
      '1.02.3',
      '1.2.3-',
      '1.2.3-01',
      'abc',
      'x'.repeat(300),
    ]) {
      expect(parseSemver(bad)).toBeNull();
    }
    expect(parseSemver(123)).toBeNull();
    expect(semverCompare('1.0.0', 'nope')).toBeNull();
  });

  it('orders according to semver 2.0.0 precedence', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
      '10.0.0',
    ];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        const expected = i === j ? 0 : i < j ? -1 : 1;
        expect(compareSemver(parseSemver(ordered[i])!, parseSemver(ordered[j])!)).toBe(expected);
      }
    }
  });

  it('ignores build metadata', () => {
    expect(semverCompare('1.0.0+a', '1.0.0+b')).toBe(0);
  });
});
