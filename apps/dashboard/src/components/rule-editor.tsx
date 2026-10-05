import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import type { Rule, Variation } from '@/lib/types';
import { ClauseBuilder } from './clause-builder';
import { ServeEditor } from './serve-editor';
import { Button } from './ui/button';
import { Card, Input } from './ui/primitives';

export function newRuleId() {
  return Math.random().toString(36).slice(2, 10);
}

function SortableRule({
  rule,
  index,
  variations,
  attributes,
  segments,
  onChange,
  onRemove,
}: {
  rule: Rule;
  index: number;
  variations: Variation[];
  attributes: string[];
  segments: string[];
  onChange(rule: Rule): void;
  onRemove(): void;
}) {
  const sortable = useSortable({ id: rule.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div ref={sortable.setNodeRef} style={style} data-testid={`rule-${index}`}>
      <Card className={sortable.isDragging ? 'shadow-lg ring-2 ring-primary/40' : ''}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <button
            className="cursor-grab rounded p-1 text-muted-foreground hover:bg-accent active:cursor-grabbing"
            {...sortable.attributes}
            {...sortable.listeners}
            aria-label="Drag to reorder"
            data-testid={`rule-${index}-handle`}
          >
            <GripVertical className="size-4" />
          </button>
          <span className="text-xs font-semibold text-muted-foreground">RULE {index + 1}</span>
          <Input
            className="h-7 flex-1 border-transparent bg-transparent shadow-none"
            placeholder="Describe this rule"
            value={rule.description ?? ''}
            onChange={(e) => onChange({ ...rule, description: e.target.value || undefined })}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={onRemove}
            title="Delete rule"
            data-testid={`rule-${index}-delete`}
          >
            <Trash2 />
          </Button>
        </div>
        <div className="grid gap-3 p-3">
          <div className="grid gap-2">
            {rule.clauses.map((clause, ci) => (
              <div key={ci} className="flex items-start gap-2">
                <span className="mt-2 w-10 text-right text-xs font-semibold text-muted-foreground">
                  {ci === 0 ? 'IF' : 'AND'}
                </span>
                <ClauseBuilder
                  testId={`rule-${index}-clause-${ci}`}
                  clause={clause}
                  attributes={attributes}
                  segments={segments}
                  onChange={(next) =>
                    onChange({ ...rule, clauses: rule.clauses.map((c, i) => (i === ci ? next : c)) })
                  }
                  onRemove={() => onChange({ ...rule, clauses: rule.clauses.filter((_, i) => i !== ci) })}
                />
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="ml-12 w-fit"
              data-testid={`rule-${index}-add-clause`}
              onClick={() =>
                onChange({ ...rule, clauses: [...rule.clauses, { attribute: '', op: 'in', values: [] }] })
              }
            >
              <Plus /> Add condition
            </Button>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-2 w-10 text-right text-xs font-semibold text-muted-foreground">THEN</span>
            <div className="flex-1">
              <ServeEditor
                testId={`rule-${index}-serve`}
                serve={rule.serve}
                variations={variations}
                onChange={(serve) => onChange({ ...rule, serve })}
              />
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function RuleEditor({
  rules,
  variations,
  attributes,
  segments,
  onChange,
}: {
  rules: Rule[];
  variations: Variation[];
  attributes: string[];
  segments: string[];
  onChange(rules: Rule[]): void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = rules.findIndex((r) => r.id === active.id);
    const to = rules.findIndex((r) => r.id === over.id);
    onChange(arrayMove(rules, from, to));
  };
  return (
    <div className="grid gap-3">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={rules.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          {rules.map((rule, index) => (
            <SortableRule
              key={rule.id}
              rule={rule}
              index={index}
              variations={variations}
              attributes={attributes}
              segments={segments}
              onChange={(next) => onChange(rules.map((r) => (r.id === rule.id ? next : r)))}
              onRemove={() => onChange(rules.filter((r) => r.id !== rule.id))}
            />
          ))}
        </SortableContext>
      </DndContext>
      <Button
        variant="outline"
        className="w-fit"
        data-testid="add-rule"
        onClick={() =>
          onChange([
            ...rules,
            {
              id: newRuleId(),
              clauses: [{ attribute: '', op: 'in', values: [] }],
              serve: { variation: variations[0]!.id },
            },
          ])
        }
      >
        <Plus /> Add rule
      </Button>
    </div>
  );
}
