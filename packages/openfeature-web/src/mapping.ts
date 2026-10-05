import {
  ErrorCode,
  StandardResolutionReasons,
  type EvaluationContext,
  type JsonValue,
  type ResolutionDetails,
} from '@openfeature/web-sdk';
import type { Context, Detail as FlagDetail } from '@ashamrai/flags-web';

function isNestedContext(value: unknown): value is Record<string, unknown> & { key: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { key?: unknown }).key === 'string'
  );
}

export function toFlagsContext(context: EvaluationContext): Context {
  const { targetingKey, kind, ...rest } = context as EvaluationContext & { kind?: unknown };
  const primary: Record<string, unknown> = {};
  const nested: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(rest)) {
    if (isNestedContext(value)) nested[name] = value;
    else primary[name] = value instanceof Date ? value.toISOString() : value;
  }
  const primaryKind = typeof kind === 'string' && kind !== 'multi' ? kind : 'user';
  const hasPrimary = typeof targetingKey === 'string' && targetingKey.length > 0;
  if (Object.keys(nested).length === 0) {
    return { kind: primaryKind, key: hasPrimary ? targetingKey : '', ...primary } as Context;
  }
  const multi: Record<string, unknown> = { kind: 'multi', ...nested };
  if (hasPrimary) multi[primaryKind] = { key: targetingKey, ...primary };
  return multi as Context;
}

const ERROR_CODES: Record<string, ErrorCode> = {
  FLAG_NOT_FOUND: ErrorCode.FLAG_NOT_FOUND,
  WRONG_TYPE: ErrorCode.TYPE_MISMATCH,
  INVALID_CONTEXT: ErrorCode.INVALID_CONTEXT,
  MALFORMED_FLAG: ErrorCode.PARSE_ERROR,
  CLIENT_NOT_READY: ErrorCode.PROVIDER_NOT_READY,
  EXCEPTION: ErrorCode.GENERAL,
};

export function toResolution<T>(
  detail: FlagDetail<unknown>,
  defaultValue: T,
  targetingKeyMissing = false,
): ResolutionDetails<T> {
  const reason = detail.reason as {
    kind: string;
    errorKind?: string;
    inExperiment?: boolean;
    ruleId?: string;
    ruleIndex?: number;
    prerequisiteKey?: string;
  };
  const flagMetadata: Record<string, string | number | boolean> = { reasonKind: reason.kind };
  if (reason.ruleId) flagMetadata.ruleId = reason.ruleId;
  if (typeof reason.ruleIndex === 'number') flagMetadata.ruleIndex = reason.ruleIndex;
  if (reason.prerequisiteKey) flagMetadata.prerequisiteKey = reason.prerequisiteKey;
  if (reason.inExperiment) flagMetadata.inExperiment = true;
  if (reason.kind === 'ERROR') {
    const code =
      targetingKeyMissing && reason.errorKind === 'INVALID_CONTEXT'
        ? ErrorCode.TARGETING_KEY_MISSING
        : (ERROR_CODES[reason.errorKind ?? ''] ?? ErrorCode.GENERAL);
    return {
      value: defaultValue,
      reason: StandardResolutionReasons.ERROR,
      errorCode: code,
      errorMessage: reason.errorKind,
      flagMetadata,
    };
  }
  const mapped =
    reason.kind === 'OFF' || reason.kind === 'PREREQUISITE_FAILED'
      ? StandardResolutionReasons.DISABLED
      : reason.kind === 'TARGET_MATCH' || (reason.kind === 'RULE_MATCH' && !reason.inExperiment)
        ? StandardResolutionReasons.TARGETING_MATCH
        : reason.inExperiment
          ? StandardResolutionReasons.SPLIT
          : StandardResolutionReasons.DEFAULT;
  const resolution: ResolutionDetails<T> = { value: detail.value as T, reason: mapped, flagMetadata };
  if (detail.variationId) resolution.variant = detail.variationId;
  return resolution;
}

export type { JsonValue };
