import { z } from 'zod';
import { clauseSchema, contextKindSchema, ruleSchema, serveSchema, targetSchema } from './flags';
import type { Clause, FlagConfig, Rule, Serve, Target } from './flags';

const newRuleSchema = ruleSchema.extend({ id: z.string().min(1).max(64).optional() });

export const instructionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('turnOn') }),
  z.object({ kind: z.literal('turnOff') }),
  z.object({ kind: z.literal('addRule'), rule: newRuleSchema, beforeRuleId: z.string().optional() }),
  z.object({ kind: z.literal('removeRule'), ruleId: z.string() }),
  z.object({ kind: z.literal('updateRuleClauses'), ruleId: z.string(), clauses: z.array(clauseSchema) }),
  z.object({ kind: z.literal('addClauses'), ruleId: z.string(), clauses: z.array(clauseSchema).min(1) }),
  z.object({ kind: z.literal('updateRuleServe'), ruleId: z.string(), serve: serveSchema }),
  z.object({
    kind: z.literal('updateRuleDescription'),
    ruleId: z.string(),
    description: z.string().max(500),
  }),
  z.object({ kind: z.literal('reorderRules'), ruleIds: z.array(z.string()) }),
  z.object({ kind: z.literal('updateFallthrough'), serve: serveSchema }),
  z.object({ kind: z.literal('updateOffVariation'), variationId: z.string().nullable() }),
  z.object({
    kind: z.literal('addTargets'),
    variationId: z.string(),
    contextKind: contextKindSchema.default('user'),
    keys: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('removeTargets'),
    variationId: z.string(),
    contextKind: contextKindSchema.default('user'),
    keys: z.array(z.string().min(1)).min(1),
  }),
  z.object({ kind: z.literal('replaceTargets'), targets: z.array(targetSchema) }),
]);

export const instructionListSchema = z.array(instructionSchema).min(1).max(100);

export const patchRequestSchema = z.object({
  instructions: instructionListSchema,
  comment: z.string().max(1000).optional(),
});

export type Instruction = z.infer<typeof instructionSchema>;
export type InstructionInput = z.input<typeof instructionSchema>;
export type PatchRequest = z.infer<typeof patchRequestSchema>;

export class PatchError extends Error {
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(`instruction ${index}: ${message}`);
    this.name = 'PatchError';
  }
}

export interface PatchFlagInfo {
  variations: Array<{ id: string; value: unknown; name?: string }>;
}

export type PatchableConfig = Pick<FlagConfig, 'on' | 'offVariation' | 'targets' | 'rules' | 'fallthrough'>;

function variationLabel(flag: PatchFlagInfo | undefined, id: string | null): string {
  if (id === null) return 'default value';
  const variation = flag?.variations.find((v) => v.id === id);
  if (!variation) return id;
  return variation.name ?? JSON.stringify(variation.value);
}

export function describeClause(clause: Clause): string {
  const kind = clause.contextKind && clause.contextKind !== 'user' ? `${clause.contextKind}.` : '';
  const op = clause.negate ? `not ${clause.op}` : clause.op;
  const values = clause.values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  if (clause.op === 'segment_match') return `${clause.negate ? 'not in' : 'in'} segment [${values}]`;
  return `${kind}${clause.attribute} ${op} [${values}]`;
}

export function describeServe(serve: Serve, flag?: PatchFlagInfo): string {
  if ('variation' in serve) return variationLabel(flag, serve.variation);
  const by = serve.rollout.bucketBy ? ` by ${serve.rollout.bucketBy}` : '';
  const kind =
    serve.rollout.contextKind && serve.rollout.contextKind !== 'user'
      ? ` (${serve.rollout.contextKind})`
      : '';
  return `rollout${by}${kind} ${serve.rollout.weights
    .map(
      (w) =>
        `${variationLabel(flag, w.variation)} ${(w.weight / 1000).toFixed(w.weight % 1000 === 0 ? 0 : 3)}%`,
    )
    .join(' / ')}`;
}

export function describeInstruction(instruction: Instruction, flag?: PatchFlagInfo): string {
  switch (instruction.kind) {
    case 'turnOn':
      return 'turned flag on';
    case 'turnOff':
      return 'turned flag off';
    case 'addRule':
      return `added rule: ${instruction.rule.clauses.map(describeClause).join(' AND ') || 'everyone'} → ${describeServe(instruction.rule.serve, flag)}`;
    case 'removeRule':
      return `removed rule ${instruction.ruleId}`;
    case 'updateRuleClauses':
      return `changed rule ${instruction.ruleId} clauses: ${instruction.clauses.map(describeClause).join(' AND ') || 'everyone'}`;
    case 'addClauses':
      return `added clauses to rule ${instruction.ruleId}: ${instruction.clauses.map(describeClause).join(' AND ')}`;
    case 'updateRuleServe':
      return `rule ${instruction.ruleId} now serves ${describeServe(instruction.serve, flag)}`;
    case 'updateRuleDescription':
      return `renamed rule ${instruction.ruleId} to "${instruction.description}"`;
    case 'reorderRules':
      return `reordered rules: ${instruction.ruleIds.join(', ')}`;
    case 'updateFallthrough':
      return `default rule now serves ${describeServe(instruction.serve, flag)}`;
    case 'updateOffVariation':
      return `off variation is now ${variationLabel(flag, instruction.variationId)}`;
    case 'addTargets':
      return `targeted ${instruction.contextKind} ${instruction.keys.join(', ')} → ${variationLabel(flag, instruction.variationId)}`;
    case 'removeTargets':
      return `removed ${instruction.contextKind} targets ${instruction.keys.join(', ')} from ${variationLabel(flag, instruction.variationId)}`;
    case 'replaceTargets':
      return `replaced individual targets (${instruction.targets.reduce((n, t) => n + t.keys.length, 0)} keys)`;
  }
}

function cloneConfig<T extends PatchableConfig>(config: T): T {
  return JSON.parse(JSON.stringify(config)) as T;
}

function checkServe(serve: Serve, ids: Set<string>, index: number) {
  if ('variation' in serve) {
    if (!ids.has(serve.variation)) throw new PatchError(index, `unknown variation ${serve.variation}`);
    return;
  }
  for (const w of serve.rollout.weights) {
    if (!ids.has(w.variation)) throw new PatchError(index, `unknown variation ${w.variation}`);
  }
}

function findRule(rules: Rule[], ruleId: string, index: number): Rule {
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) throw new PatchError(index, `rule ${ruleId} not found`);
  return rule;
}

export function randomId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

export function applyInstructions<T extends PatchableConfig>(
  config: T,
  instructions: readonly Instruction[],
  flag: PatchFlagInfo,
  generateId: () => string = randomId,
): T {
  const next = cloneConfig(config);
  const ids = new Set(flag.variations.map((v) => v.id));
  instructions.forEach((instruction, index) => {
    switch (instruction.kind) {
      case 'turnOn':
        next.on = true;
        break;
      case 'turnOff':
        next.on = false;
        break;
      case 'addRule': {
        checkServe(instruction.rule.serve, ids, index);
        const id = instruction.rule.id ?? generateId();
        if (next.rules.some((r) => r.id === id)) throw new PatchError(index, `rule ${id} already exists`);
        const rule: Rule = { ...instruction.rule, id };
        if (instruction.beforeRuleId) {
          const position = next.rules.findIndex((r) => r.id === instruction.beforeRuleId);
          if (position === -1) throw new PatchError(index, `rule ${instruction.beforeRuleId} not found`);
          next.rules.splice(position, 0, rule);
        } else {
          next.rules.push(rule);
        }
        break;
      }
      case 'removeRule': {
        findRule(next.rules, instruction.ruleId, index);
        next.rules = next.rules.filter((r) => r.id !== instruction.ruleId);
        break;
      }
      case 'updateRuleClauses':
        findRule(next.rules, instruction.ruleId, index).clauses = instruction.clauses;
        break;
      case 'addClauses':
        findRule(next.rules, instruction.ruleId, index).clauses.push(...instruction.clauses);
        break;
      case 'updateRuleServe':
        checkServe(instruction.serve, ids, index);
        findRule(next.rules, instruction.ruleId, index).serve = instruction.serve;
        break;
      case 'updateRuleDescription':
        findRule(next.rules, instruction.ruleId, index).description = instruction.description;
        break;
      case 'reorderRules': {
        const current = next.rules.map((r) => r.id).sort();
        const requested = [...instruction.ruleIds].sort();
        if (current.length !== requested.length || current.some((id, i) => id !== requested[i])) {
          throw new PatchError(index, 'reorderRules must list every rule id exactly once');
        }
        next.rules = instruction.ruleIds.map((id) => next.rules.find((r) => r.id === id)!);
        break;
      }
      case 'updateFallthrough':
        checkServe(instruction.serve, ids, index);
        next.fallthrough = instruction.serve;
        break;
      case 'updateOffVariation':
        if (instruction.variationId !== null && !ids.has(instruction.variationId)) {
          throw new PatchError(index, `unknown variation ${instruction.variationId}`);
        }
        next.offVariation = instruction.variationId;
        break;
      case 'addTargets': {
        if (!ids.has(instruction.variationId))
          throw new PatchError(index, `unknown variation ${instruction.variationId}`);
        for (const target of next.targets) {
          if (
            target.contextKind === instruction.contextKind &&
            target.variation !== instruction.variationId
          ) {
            target.keys = target.keys.filter((k) => !instruction.keys.includes(k));
          }
        }
        let target = next.targets.find(
          (t) => t.variation === instruction.variationId && t.contextKind === instruction.contextKind,
        );
        if (!target) {
          target = { variation: instruction.variationId, contextKind: instruction.contextKind, keys: [] };
          next.targets.push(target);
        }
        for (const key of instruction.keys) if (!target.keys.includes(key)) target.keys.push(key);
        next.targets = next.targets.filter((t) => t.keys.length > 0);
        break;
      }
      case 'removeTargets': {
        const target = next.targets.find(
          (t) => t.variation === instruction.variationId && t.contextKind === instruction.contextKind,
        );
        if (!target) throw new PatchError(index, 'no targets for that variation');
        target.keys = target.keys.filter((k) => !instruction.keys.includes(k));
        next.targets = next.targets.filter((t) => t.keys.length > 0);
        break;
      }
      case 'replaceTargets':
        for (const target of instruction.targets as Target[]) {
          if (!ids.has(target.variation))
            throw new PatchError(index, `unknown variation ${target.variation}`);
        }
        next.targets = instruction.targets as Target[];
        break;
    }
  });
  return next;
}

export function instructionsBetween(before: PatchableConfig, after: PatchableConfig): Instruction[] {
  const out: Instruction[] = [];
  if (before.on !== after.on) out.push({ kind: after.on ? 'turnOn' : 'turnOff' });
  if (before.offVariation !== after.offVariation)
    out.push({ kind: 'updateOffVariation', variationId: after.offVariation });
  if (JSON.stringify(before.targets) !== JSON.stringify(after.targets)) {
    out.push({ kind: 'replaceTargets', targets: after.targets });
  }
  const afterIds = new Set(after.rules.map((r) => r.id));
  for (const rule of before.rules)
    if (!afterIds.has(rule.id)) out.push({ kind: 'removeRule', ruleId: rule.id });
  const beforeById = new Map(before.rules.map((r) => [r.id, r]));
  for (const rule of after.rules) {
    const existing = beforeById.get(rule.id);
    if (!existing) {
      out.push({ kind: 'addRule', rule });
      continue;
    }
    if (JSON.stringify(existing.clauses) !== JSON.stringify(rule.clauses)) {
      out.push({ kind: 'updateRuleClauses', ruleId: rule.id, clauses: rule.clauses });
    }
    if (JSON.stringify(existing.serve) !== JSON.stringify(rule.serve)) {
      out.push({ kind: 'updateRuleServe', ruleId: rule.id, serve: rule.serve });
    }
    if ((existing.description ?? '') !== (rule.description ?? '')) {
      out.push({ kind: 'updateRuleDescription', ruleId: rule.id, description: rule.description ?? '' });
    }
  }
  const remaining = before.rules.filter((r) => afterIds.has(r.id)).map((r) => r.id);
  const added = after.rules.filter((r) => !beforeById.has(r.id)).map((r) => r.id);
  const expected = [...remaining, ...added];
  const actual = after.rules.map((r) => r.id);
  if (expected.join('\u0000') !== actual.join('\u0000') && actual.length > 0) {
    out.push({ kind: 'reorderRules', ruleIds: actual });
  }
  if (JSON.stringify(before.fallthrough) !== JSON.stringify(after.fallthrough)) {
    out.push({ kind: 'updateFallthrough', serve: after.fallthrough });
  }
  return out;
}

export type { Clause };
