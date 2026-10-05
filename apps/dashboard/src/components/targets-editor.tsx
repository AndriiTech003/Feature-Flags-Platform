import type { Target, Variation } from '@/lib/types';
import { variationLabel } from './serve-editor';
import { Badge, NativeSelect, Textarea } from './ui/primitives';
import { useState } from 'react';

export function TargetsEditor({
  targets,
  variations,
  onChange,
}: {
  targets: Target[];
  variations: Variation[];
  onChange(targets: Target[]): void;
}) {
  const [kind, setKind] = useState('user');
  const kinds = Array.from(new Set(['user', ...targets.map((t) => t.contextKind ?? 'user')]));
  const keysFor = (variation: string) =>
    targets.find((t) => t.variation === variation && (t.contextKind ?? 'user') === kind)?.keys ?? [];
  const setKeys = (variation: string, keys: string[]) => {
    const others = targets.filter((t) => !(t.variation === variation && (t.contextKind ?? 'user') === kind));
    const cleaned = Array.from(new Set(keys));
    const deduped = others.map((t) =>
      (t.contextKind ?? 'user') === kind ? { ...t, keys: t.keys.filter((k) => !cleaned.includes(k)) } : t,
    );
    onChange(
      [...deduped, ...(cleaned.length ? [{ variation, contextKind: kind, keys: cleaned }] : [])].filter(
        (t) => t.keys.length > 0,
      ),
    );
  };
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2 text-sm">
        Context kind
        <NativeSelect value={kind} onChange={(e) => setKind(e.target.value)}>
          {[...kinds, 'organization', 'device']
            .filter((k, i, a) => a.indexOf(k) === i)
            .map((k) => (
              <option key={k}>{k}</option>
            ))}
        </NativeSelect>
      </div>
      {variations.map((variation) => (
        <div key={variation.id} className="grid gap-1.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            Serve <Badge>{variationLabel(variations, variation.id)}</Badge> to
          </div>
          <Textarea
            rows={2}
            className="font-mono text-xs"
            data-testid={`targets-${variation.id}`}
            placeholder={`${kind} keys, comma or newline separated`}
            defaultValue={keysFor(variation.id).join(', ')}
            key={`${kind}-${variation.id}-${keysFor(variation.id).join(',')}`}
            onBlur={(e) =>
              setKeys(
                variation.id,
                e.target.value
                  .split(/[\s,]+/)
                  .map((k) => k.trim())
                  .filter(Boolean),
              )
            }
          />
        </div>
      ))}
    </div>
  );
}
