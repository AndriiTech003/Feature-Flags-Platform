import { attributeValue, contextOfKind, isValidContext } from './context';
import { bucketFor } from './bucketing';
import { matchAny, positiveOp } from './operators';
import type {
  Clause,
  Context,
  ErrorKind,
  EvaluateOptions,
  EvaluationDetail,
  EvaluationReason,
  EvaluationStore,
  Flag,
  FlagConfig,
  FlagKind,
  FlagWithConfig,
  Ruleset,
  Segment,
  Serve,
} from './types';

class MalformedError extends Error {}
class CycleError extends Error {}

interface ServeResult {
  variationId: string;
  inExperiment: boolean;
}

interface State {
  store: EvaluationStore;
  flagStack: string[];
  segmentStack: string[];
}

const setCache = new WeakMap<readonly string[], Set<string>>();

function asSet(keys: readonly string[]): Set<string> {
  let set = setCache.get(keys);
  if (!set) {
    set = new Set(keys);
    setCache.set(keys, set);
  }
  return set;
}

function errorDetail<T>(errorKind: ErrorKind, defaultValue: T): EvaluationDetail<T> {
  return { value: defaultValue, variationId: null, reason: { kind: 'ERROR', errorKind } };
}

function matchesKind(value: unknown, kind: FlagKind): boolean {
  switch (kind) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'json':
      return value !== undefined;
  }
}

function resolveServe(flag: Flag, serve: Serve, context: Context, config: FlagConfig): ServeResult {
  if (!serve || typeof serve !== 'object') throw new MalformedError();
  if ('variation' in serve && typeof serve.variation === 'string') {
    return { variationId: serve.variation, inExperiment: false };
  }
  if ('rollout' in serve && serve.rollout && Array.isArray(serve.rollout.weights)) {
    const rollout = serve.rollout;
    if (rollout.weights.length === 0) throw new MalformedError();
    const ctx = contextOfKind(context, rollout.contextKind ?? 'user');
    let bucket = 0;
    let bucketed = false;
    if (ctx) {
      const raw = attributeValue(ctx, rollout.contextKind ?? 'user', rollout.bucketBy ?? 'key');
      let bucketKey: string | null = null;
      if (typeof raw === 'string') bucketKey = raw;
      else if (typeof raw === 'number' && Number.isInteger(raw)) bucketKey = String(raw);
      if (bucketKey !== null) {
        bucket = bucketFor(flag.key, flag.salt, bucketKey);
        bucketed = true;
      }
    }
    let cumulative = 0;
    let chosen: string | undefined;
    for (const weight of rollout.weights) {
      if (typeof weight.weight !== 'number' || weight.weight < 0 || typeof weight.variation !== 'string') {
        throw new MalformedError();
      }
      cumulative += weight.weight;
      if (bucket < cumulative) {
        chosen = weight.variation;
        break;
      }
    }
    if (chosen === undefined) chosen = rollout.weights[rollout.weights.length - 1]!.variation;
    return { variationId: chosen, inExperiment: bucketed && !!config.experiment };
  }
  throw new MalformedError();
}

function segmentContains(segment: Segment, context: Context, state: State): boolean {
  if (state.segmentStack.includes(segment.key)) throw new CycleError();
  const kind = segment.contextKind ?? 'user';
  const ctx = contextOfKind(context, kind);
  if (ctx) {
    if (asSet(segment.included).has(ctx.key)) return true;
    if (asSet(segment.excluded).has(ctx.key)) return false;
  }
  state.segmentStack.push(segment.key);
  try {
    for (const rule of segment.rules) {
      if (clausesMatch(rule.clauses, context, state)) return true;
    }
    return false;
  } finally {
    state.segmentStack.pop();
  }
}

function clauseMatches(clause: Clause, context: Context, state: State): boolean {
  if (!clause || !Array.isArray(clause.values)) throw new MalformedError();
  if (clause.op === 'segment_match') {
    let matched = false;
    for (const key of clause.values) {
      if (typeof key !== 'string') continue;
      const segment = state.store.getSegment(key);
      if (segment && segmentContains(segment, context, state)) {
        matched = true;
        break;
      }
    }
    return clause.negate ? !matched : matched;
  }
  const kind = clause.contextKind ?? 'user';
  const ctx = contextOfKind(context, kind);
  if (!ctx) return false;
  const actual = attributeValue(ctx, kind, clause.attribute);
  if (actual === undefined || actual === null) return false;
  const { op, invert } = positiveOp(clause.op);
  let matched = matchAny(op, actual, clause.values);
  if (invert) matched = !matched;
  return clause.negate ? !matched : matched;
}

function clausesMatch(clauses: readonly Clause[], context: Context, state: State): boolean {
  if (!Array.isArray(clauses)) throw new MalformedError();
  for (const clause of clauses) {
    if (!clauseMatches(clause, context, state)) return false;
  }
  return true;
}

interface InternalResult {
  variationId: string | null;
  reason: EvaluationReason;
}

function evaluateInternal(flag: Flag, config: FlagConfig, context: Context, state: State): InternalResult {
  if (!config.on) return { variationId: config.offVariation ?? null, reason: { kind: 'OFF' } };

  if (flag.prerequisites && flag.prerequisites.length > 0) {
    if (state.flagStack.includes(flag.key)) throw new CycleError();
    state.flagStack.push(flag.key);
    try {
      for (const prereq of flag.prerequisites) {
        if (state.flagStack.includes(prereq.flagKey)) throw new CycleError();
        const prereqFlag = state.store.getFlag(prereq.flagKey);
        let ok = false;
        if (prereqFlag && prereqFlag.config) {
          try {
            const result = evaluateInternal(prereqFlag, prereqFlag.config, context, state);
            ok =
              prereqFlag.config.on &&
              result.reason.kind !== 'ERROR' &&
              result.variationId === prereq.variationId;
          } catch (error) {
            if (error instanceof CycleError) throw error;
            ok = false;
          }
        }
        if (!ok) {
          return {
            variationId: config.offVariation ?? null,
            reason: { kind: 'PREREQUISITE_FAILED', prerequisiteKey: prereq.flagKey },
          };
        }
      }
    } finally {
      state.flagStack.pop();
    }
  }

  for (const target of config.targets) {
    const ctx = contextOfKind(context, target.contextKind ?? 'user');
    if (ctx && asSet(target.keys).has(ctx.key)) {
      return { variationId: target.variation, reason: { kind: 'TARGET_MATCH' } };
    }
  }

  const rules = config.rules;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (clausesMatch(rule.clauses, context, state)) {
      const served = resolveServe(flag, rule.serve, context, config);
      const reason: EvaluationReason = served.inExperiment
        ? { kind: 'RULE_MATCH', ruleIndex: i, ruleId: rule.id, inExperiment: true }
        : { kind: 'RULE_MATCH', ruleIndex: i, ruleId: rule.id };
      return { variationId: served.variationId, reason };
    }
  }

  const served = resolveServe(flag, config.fallthrough, context, config);
  return {
    variationId: served.variationId,
    reason: served.inExperiment ? { kind: 'FALLTHROUGH', inExperiment: true } : { kind: 'FALLTHROUGH' },
  };
}

export function evaluate<T = unknown>(
  flag: Flag | undefined | null,
  config: FlagConfig | undefined | null,
  context: Context,
  store: EvaluationStore,
  options: EvaluateOptions<T> = {},
): EvaluationDetail<T> {
  const defaultValue = options.defaultValue as T;
  try {
    if (!flag || !config) return errorDetail('FLAG_NOT_FOUND', defaultValue);
    if (!isValidContext(context)) return errorDetail('INVALID_CONTEXT', defaultValue);
    if (!Array.isArray(flag.variations) || !Array.isArray(config.targets) || !Array.isArray(config.rules)) {
      return errorDetail('MALFORMED_FLAG', defaultValue);
    }
    const state: State = { store, flagStack: [], segmentStack: [] };
    const result = evaluateInternal(flag, config, context, state);
    if (result.variationId === null) {
      return { value: defaultValue, variationId: null, reason: result.reason };
    }
    const variation = flag.variations.find((v) => v.id === result.variationId);
    if (!variation) return errorDetail('MALFORMED_FLAG', defaultValue);
    if (options.expectedKind && !matchesKind(variation.value, options.expectedKind)) {
      return errorDetail('WRONG_TYPE', defaultValue);
    }
    return { value: variation.value as T, variationId: variation.id, reason: result.reason };
  } catch (error) {
    if (error instanceof MalformedError || error instanceof CycleError) {
      return errorDetail('MALFORMED_FLAG', defaultValue);
    }
    return errorDetail('EXCEPTION', defaultValue);
  }
}

export function createStore(ruleset: Pick<Ruleset, 'flags' | 'segments'>): EvaluationStore {
  return {
    getFlag: (key) =>
      Object.prototype.hasOwnProperty.call(ruleset.flags, key) ? ruleset.flags[key] : undefined,
    getSegment: (key) =>
      Object.prototype.hasOwnProperty.call(ruleset.segments, key) ? ruleset.segments[key] : undefined,
  };
}

export function evaluateFlag<T = unknown>(
  store: EvaluationStore,
  flagKey: string,
  context: Context,
  options: EvaluateOptions<T> = {},
): EvaluationDetail<T> {
  let flag: FlagWithConfig | undefined;
  try {
    flag = store.getFlag(flagKey);
  } catch {
    return errorDetail('EXCEPTION', options.defaultValue as T);
  }
  return evaluate(flag, flag?.config, context, store, options);
}

export interface AllFlagsOptions {
  clientSideOnly?: boolean;
  withReasons?: boolean;
}

export interface FlagState {
  value: unknown;
  variationId: string | null;
  version: number;
  reason?: EvaluationReason;
  inExperiment?: boolean;
}

export function evaluateAll(
  flags: Iterable<FlagWithConfig>,
  store: EvaluationStore,
  context: Context,
  options: AllFlagsOptions = {},
): Record<string, FlagState> {
  const out: Record<string, FlagState> = {};
  for (const flag of flags) {
    if (flag.archivedAt) continue;
    if (options.clientSideOnly && !flag.clientSideAvailable) continue;
    const detail = evaluate(flag, flag.config, context, store, { defaultValue: null });
    const state: FlagState = {
      value: detail.value,
      variationId: detail.variationId,
      version: flag.config?.version ?? 0,
    };
    if (options.withReasons) state.reason = detail.reason;
    if ('inExperiment' in detail.reason && detail.reason.inExperiment) state.inExperiment = true;
    out[flag.key] = state;
  }
  return out;
}
