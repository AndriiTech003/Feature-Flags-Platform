import { semverCompare } from './semver';
import type { ClauseOp } from './types';

export const MAX_REGEX_PATTERN_LENGTH = 256;
export const MAX_REGEX_INPUT_LENGTH = 4096;
const MAX_REGEX_CACHE = 512;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;
const BACKREFERENCE = /\\[1-9]/;

const regexCache = new Map<string, RegExp | null>();

export function compileRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  if (
    pattern.length <= MAX_REGEX_PATTERN_LENGTH &&
    !NESTED_QUANTIFIER.test(pattern) &&
    !BACKREFERENCE.test(pattern)
  ) {
    try {
      compiled = new RegExp(pattern, 'u');
    } catch {
      compiled = null;
    }
  }
  if (regexCache.size >= MAX_REGEX_CACHE) regexCache.clear();
  regexCache.set(pattern, compiled);
  return compiled;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

export function toTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && RFC3339.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}

export function matchSingle(op: ClauseOp, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'in':
    case 'eq':
      return isPrimitive(actual) && actual === expected;
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'starts_with':
      return typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected);
    case 'ends_with':
      return typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected);
    case 'matches': {
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      if (actual.length > MAX_REGEX_INPUT_LENGTH) return false;
      const regex = compileRegex(expected);
      return regex !== null && regex.test(actual);
    }
    case 'lt':
      return isNumber(actual) && isNumber(expected) && actual < expected;
    case 'lte':
      return isNumber(actual) && isNumber(expected) && actual <= expected;
    case 'gt':
      return isNumber(actual) && isNumber(expected) && actual > expected;
    case 'gte':
      return isNumber(actual) && isNumber(expected) && actual >= expected;
    case 'semver_eq':
      return semverCompare(actual, expected) === 0;
    case 'semver_lt':
      return semverCompare(actual, expected) === -1;
    case 'semver_gt':
      return semverCompare(actual, expected) === 1;
    case 'before': {
      const a = toTimestamp(actual);
      const b = toTimestamp(expected);
      return a !== null && b !== null && a < b;
    }
    case 'after': {
      const a = toTimestamp(actual);
      const b = toTimestamp(expected);
      return a !== null && b !== null && a > b;
    }
    default:
      return false;
  }
}

export function positiveOp(op: ClauseOp): { op: ClauseOp; invert: boolean } {
  if (op === 'not_in') return { op: 'in', invert: true };
  if (op === 'neq') return { op: 'eq', invert: true };
  return { op, invert: false };
}

export function matchAny(op: ClauseOp, actual: unknown, values: readonly unknown[]): boolean {
  if (Array.isArray(actual)) {
    for (const item of actual) {
      if (item === null || item === undefined) continue;
      for (const expected of values) if (matchSingle(op, item, expected)) return true;
    }
    return false;
  }
  for (const expected of values) if (matchSingle(op, actual, expected)) return true;
  return false;
}
