import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { FlagInsights, Variation } from '@/lib/types';
import { relativeTime, VARIATION_COLORS } from '@/lib/utils';
import { variationLabel } from './serve-editor';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/primitives';

export function InsightsChart({
  insights,
  variations,
}: {
  insights: FlagInsights | undefined;
  variations: Variation[];
}) {
  const buckets = new Map<string, Record<string, number | string>>();
  for (const point of insights?.series ?? []) {
    const label = new Date(point.bucket).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
    });
    const row = buckets.get(point.bucket) ?? { label };
    row[point.variationId ?? 'none'] = ((row[point.variationId ?? 'none'] as number) ?? 0) + point.count;
    buckets.set(point.bucket, row);
  }
  const data = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
  const total = (list: FlagInsights['last24h'] | undefined) => (list ?? []).reduce((s, x) => s + x.count, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Insights {insights?.stale ? <Badge variant="warning">stale</Badge> : null}
        </CardTitle>
        <CardDescription>
          Evaluations reported by SDKs in {insights?.envKey ?? '…'} · last evaluated{' '}
          {relativeTime(insights?.lastEvaluatedAt)}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">Last 24 hours</div>
            <div className="text-xl font-semibold" data-testid="insights-24h">
              {total(insights?.last24h).toLocaleString()}
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">Last 7 days</div>
            <div className="text-xl font-semibold">{total(insights?.last7d).toLocaleString()}</div>
          </div>
          {(insights?.last7d ?? []).slice(0, 2).map((v) => (
            <div key={v.variationId ?? 'none'} className="rounded-lg border p-3">
              <div className="truncate text-xs text-muted-foreground">
                {variationLabel(variations, v.variationId)} · 7d
              </div>
              <div className="text-xl font-semibold">{v.count.toLocaleString()}</div>
            </div>
          ))}
        </div>
        <div className="h-64">
          {data.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No evaluations reported yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={40} />
                <YAxis tick={{ fontSize: 11 }} width={48} />
                <Tooltip />
                <Legend />
                {variations.map((v, i) => (
                  <Bar
                    key={v.id}
                    dataKey={v.id}
                    name={variationLabel(variations, v.id)}
                    stackId="a"
                    fill={VARIATION_COLORS[i % VARIATION_COLORS.length]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
