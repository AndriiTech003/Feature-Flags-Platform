import type { DiffEntry } from '@/lib/types';
import { cn } from '@/lib/utils';

function show(value: unknown) {
  return value === undefined ? '' : JSON.stringify(value);
}

export function JsonDiff({ entries, className }: { entries: DiffEntry[]; className?: string }) {
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">No differences.</p>;
  return (
    <div
      className={cn('max-h-80 overflow-auto rounded-lg border bg-muted/30 font-mono text-xs', className)}
      data-testid="json-diff"
    >
      {entries.map((entry, i) => (
        <div key={i} className="border-b px-3 py-1.5 last:border-0">
          <div className="text-muted-foreground">{entry.path}</div>
          {entry.op !== 'added' ? <div className="break-all text-red-700">- {show(entry.before)}</div> : null}
          {entry.op !== 'removed' ? (
            <div className="break-all text-emerald-700">+ {show(entry.after)}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
