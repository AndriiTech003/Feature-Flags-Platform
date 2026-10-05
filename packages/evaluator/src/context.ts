import type { Context } from './types';

export type ContextRecord = Record<string, unknown> & { key: string };

const KIND_PATTERN = /^[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSingle(value: unknown): value is ContextRecord {
  return isRecord(value) && typeof value.key === 'string' && value.key.length > 0;
}

export function isValidContext(context: unknown): context is Context {
  if (!isRecord(context)) return false;
  const kind = context.kind === undefined ? 'user' : context.kind;
  if (typeof kind !== 'string') return false;
  if (kind === 'multi') {
    let count = 0;
    for (const name of Object.keys(context)) {
      if (name === 'kind') continue;
      if (!KIND_PATTERN.test(name) || name === 'multi') return false;
      if (!validSingle(context[name])) return false;
      count++;
    }
    return count > 0;
  }
  if (!KIND_PATTERN.test(kind) || kind === 'kind') return false;
  return validSingle(context);
}

export function contextOfKind(context: Context, kind: string): ContextRecord | undefined {
  const record = context as Record<string, unknown>;
  const ownKind = record.kind === undefined ? 'user' : record.kind;
  if (ownKind === 'multi') {
    const nested = record[kind];
    return validSingle(nested) ? nested : undefined;
  }
  return ownKind === kind ? (record as ContextRecord) : undefined;
}

export function contextKinds(context: Context): string[] {
  const record = context as Record<string, unknown>;
  const ownKind = record.kind === undefined ? 'user' : record.kind;
  if (ownKind === 'multi') return Object.keys(record).filter((k) => k !== 'kind');
  return [String(ownKind)];
}

export function attributeValue(ctx: ContextRecord, kind: string, attribute: string): unknown {
  if (attribute === 'key') return ctx.key;
  if (attribute === 'kind') return kind;
  const direct = ctx[attribute];
  if (direct !== undefined || attribute.indexOf('.') === -1) return direct;
  let current: unknown = ctx;
  for (const part of attribute.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function canonicalContextKey(context: Context): string {
  const kinds = contextKinds(context).sort();
  return kinds
    .map((kind) => {
      const ctx = contextOfKind(context, kind);
      return ctx ? `${kind}:${encodeURIComponent(ctx.key)}` : '';
    })
    .join(':');
}
