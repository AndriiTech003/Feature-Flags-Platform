import type { Serve, Variation } from '@/lib/types';
import { displayValue, percent, VARIATION_COLORS } from '@/lib/utils';
import { Slider } from './ui/overlays';
import { Input, NativeSelect } from './ui/primitives';

export function variationLabel(variations: Variation[], id: string | null) {
  if (id === null) return 'default value';
  const v = variations.find((x) => x.id === id);
  return v ? (v.name ?? displayValue(v.value)) : id;
}

export function DistributionBar({
  weights,
  variations,
}: {
  weights: Array<{ variation: string; weight: number }>;
  variations: Variation[];
}) {
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" data-testid="distribution-bar">
      {weights.map((w) => {
        const index = variations.findIndex((v) => v.id === w.variation);
        return (
          <div
            key={w.variation}
            style={{
              width: `${w.weight / 1000}%`,
              background: VARIATION_COLORS[index % VARIATION_COLORS.length],
            }}
            title={`${variationLabel(variations, w.variation)} ${percent(w.weight)}`}
          />
        );
      })}
    </div>
  );
}

function evenWeights(variations: Variation[]) {
  const base = Math.floor(100000 / variations.length);
  return variations.map((v, i) => ({
    variation: v.id,
    weight: i === variations.length - 1 ? 100000 - base * (variations.length - 1) : base,
  }));
}

export function ServeEditor({
  serve,
  variations,
  onChange,
  testId,
}: {
  serve: Serve;
  variations: Variation[];
  onChange(serve: Serve): void;
  testId?: string;
}) {
  const isRollout = 'rollout' in serve;
  const weights = isRollout ? serve.rollout.weights : [];
  const setWeights = (next: Array<{ variation: string; weight: number }>) => {
    if (!isRollout) return;
    onChange({ rollout: { ...serve.rollout, weights: next } });
  };
  const setTwoWay = (firstPercent: number) => {
    const first = Math.round(firstPercent * 1000);
    setWeights([
      { variation: weights[0]!.variation, weight: first },
      { variation: weights[1]!.variation, weight: 100000 - first },
    ]);
  };
  const setOne = (index: number, value: number) => {
    const next = weights.map((w) => ({ ...w }));
    next[index]!.weight = Math.max(0, Math.min(100000, Math.round(value * 1000)));
    const others = next.length - 1;
    const remainder = 100000 - next[index]!.weight;
    const otherTotal = next.reduce((s, w, i) => (i === index ? s : s + w.weight), 0);
    let assigned = 0;
    next.forEach((w, i) => {
      if (i === index) return;
      const share =
        otherTotal > 0 ? Math.floor((w.weight / otherTotal) * remainder) : Math.floor(remainder / others);
      w.weight = share;
      assigned += share;
    });
    const fix = next.findIndex((_, i) => i !== index);
    if (fix >= 0) next[fix]!.weight += remainder - assigned;
    setWeights(next);
  };
  return (
    <div className="grid gap-3" data-testid={testId}>
      <NativeSelect
        data-testid={testId ? `${testId}-mode` : undefined}
        value={isRollout ? '__rollout' : serve.variation}
        onChange={(e) => {
          const value = e.target.value;
          if (value === '__rollout') onChange({ rollout: { weights: evenWeights(variations) } });
          else onChange({ variation: value });
        }}
      >
        {variations.map((v) => (
          <option key={v.id} value={v.id}>
            Serve {variationLabel(variations, v.id)}
          </option>
        ))}
        <option value="__rollout">Percentage rollout</option>
      </NativeSelect>
      {isRollout ? (
        <div className="grid gap-3 rounded-lg border bg-muted/30 p-3">
          <DistributionBar weights={weights} variations={variations} />
          {weights.length === 2 ? (
            <div className="grid gap-2">
              <div className="flex items-center justify-between text-sm">
                <span>
                  {variationLabel(variations, weights[0]!.variation)}{' '}
                  <b data-testid={testId ? `${testId}-first-percent` : undefined}>
                    {percent(weights[0]!.weight)}
                  </b>
                </span>
                <span>
                  {variationLabel(variations, weights[1]!.variation)} <b>{percent(weights[1]!.weight)}</b>
                </span>
              </div>
              <Slider
                data-testid={testId ? `${testId}-slider` : undefined}
                min={0}
                max={100}
                step={0.5}
                value={[weights[0]!.weight / 1000]}
                onValueChange={([v]) => setTwoWay(v ?? 0)}
              />
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                Exact:
                <Input
                  type="number"
                  className="h-7 w-24"
                  data-testid={testId ? `${testId}-percent-input` : undefined}
                  min={0}
                  max={100}
                  step={0.001}
                  value={weights[0]!.weight / 1000}
                  onChange={(e) => setTwoWay(Math.max(0, Math.min(100, Number(e.target.value))))}
                />
                % to {variationLabel(variations, weights[0]!.variation)}
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              {weights.map((w, index) => (
                <div key={w.variation} className="flex items-center gap-2 text-sm">
                  <span
                    className="size-2.5 rounded-full"
                    style={{
                      background:
                        VARIATION_COLORS[
                          variations.findIndex((v) => v.id === w.variation) % VARIATION_COLORS.length
                        ],
                    }}
                  />
                  <span className="w-40 truncate">{variationLabel(variations, w.variation)}</span>
                  <Input
                    type="number"
                    className="h-7 w-24"
                    step={0.001}
                    value={w.weight / 1000}
                    onChange={(e) => setOne(index, Number(e.target.value))}
                  />
                  %
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            Bucket by
            <Input
              className="h-7 w-32"
              placeholder="key"
              value={serve.rollout.bucketBy ?? ''}
              onChange={(e) =>
                onChange({ rollout: { ...serve.rollout, bucketBy: e.target.value || undefined } })
              }
            />
            of context kind
            <Input
              className="h-7 w-32"
              placeholder="user"
              value={serve.rollout.contextKind ?? ''}
              onChange={(e) =>
                onChange({ rollout: { ...serve.rollout, contextKind: e.target.value || undefined } })
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
