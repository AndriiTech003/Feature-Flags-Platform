import { Trash2 } from 'lucide-react';
import { useId } from 'react';
import type { Rule } from '@/lib/types';
import { Button } from './ui/button';
import { Checkbox, Input, NativeSelect } from './ui/primitives';

export type Clause = Rule['clauses'][number];

export const OPERATORS: Array<{ value: Clause['op']; label: string }> = [
  { value: 'in', label: 'is one of' },
  { value: 'not_in', label: 'is not one of' },
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'matches', label: 'matches regex' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'semver_eq', label: 'semver =' },
  { value: 'semver_lt', label: 'semver <' },
  { value: 'semver_gt', label: 'semver >' },
  { value: 'before', label: 'before (date)' },
  { value: 'after', label: 'after (date)' },
  { value: 'segment_match', label: 'is in segment' },
];

const NUMERIC = new Set(['lt', 'lte', 'gt', 'gte']);

export function parseValues(op: Clause['op'], raw: string): unknown[] {
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => {
      if (NUMERIC.has(op) && Number.isFinite(Number(v))) return Number(v);
      if ((op === 'in' || op === 'eq' || op === 'not_in' || op === 'neq') && (v === 'true' || v === 'false'))
        return v === 'true';
      return v;
    });
}

export function formatValues(values: unknown[]): string {
  return values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
}

export function ClauseBuilder({
  clause,
  attributes,
  segments,
  onChange,
  onRemove,
  testId,
}: {
  clause: Clause;
  attributes: string[];
  segments: string[];
  onChange(clause: Clause): void;
  onRemove(): void;
  testId?: string;
}) {
  const listId = useId();
  const isSegment = clause.op === 'segment_match';
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
      {!isSegment ? (
        <>
          <NativeSelect
            className="w-32"
            value={clause.contextKind ?? 'user'}
            onChange={(e) =>
              onChange({ ...clause, contextKind: e.target.value === 'user' ? undefined : e.target.value })
            }
          >
            <option value="user">user</option>
            <option value="organization">organization</option>
            <option value="device">device</option>
          </NativeSelect>
          <Input
            list={listId}
            className="w-40 font-mono"
            placeholder="attribute"
            data-testid={testId ? `${testId}-attribute` : undefined}
            value={clause.attribute}
            onChange={(e) => onChange({ ...clause, attribute: e.target.value })}
          />
          <datalist id={listId}>
            {['key', ...attributes].map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </>
      ) : null}
      <NativeSelect
        className="w-40"
        data-testid={testId ? `${testId}-op` : undefined}
        value={clause.op}
        onChange={(e) => {
          const op = e.target.value as Clause['op'];
          onChange({
            ...clause,
            op,
            attribute:
              op === 'segment_match' ? 'segment' : clause.attribute === 'segment' ? '' : clause.attribute,
            values: parseValues(op, formatValues(clause.values)),
          });
        }}
      >
        {OPERATORS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
      {isSegment ? (
        <NativeSelect
          className="w-56"
          value={String(clause.values[0] ?? '')}
          onChange={(e) => onChange({ ...clause, values: e.target.value ? [e.target.value] : [] })}
        >
          <option value="">choose a segment</option>
          {segments.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input
          className="min-w-48 flex-1"
          placeholder="values, comma separated"
          data-testid={testId ? `${testId}-values` : undefined}
          defaultValue={formatValues(clause.values)}
          onBlur={(e) => onChange({ ...clause, values: parseValues(clause.op, e.target.value) })}
          onKeyDown={(e) => {
            if (e.key === 'Enter')
              onChange({ ...clause, values: parseValues(clause.op, (e.target as HTMLInputElement).value) });
          }}
        />
      )}
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Checkbox
          checked={clause.negate === true}
          onCheckedChange={(v) => onChange({ ...clause, negate: v === true ? true : undefined })}
        />{' '}
        negate
      </label>
      <Button variant="ghost" size="icon" onClick={onRemove} title="Remove condition">
        <Trash2 />
      </Button>
    </div>
  );
}
