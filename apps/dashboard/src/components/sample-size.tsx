import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '@/lib/api';
import type { SampleSizeResult } from '@ashamrai/flags-contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from './ui/primitives';

export function SampleSizeCalculator({
  variants = 2,
  baseline = 0.1,
}: {
  variants?: number;
  baseline?: number;
}) {
  const [rate, setRate] = useState((baseline * 100).toFixed(1));
  const [mde, setMde] = useState('8');
  const [power, setPower] = useState('80');
  const [count, setCount] = useState(String(variants));
  const params = new URLSearchParams({
    baselineRate: String(Number(rate) / 100),
    minimumDetectableEffect: String(Number(mde) / 100),
    power: String(Number(power) / 100),
    variants: count,
  });
  const valid =
    Number(rate) > 0 &&
    Number(rate) < 100 &&
    Number(mde) > 0 &&
    Number(power) > 50 &&
    Number(power) < 100 &&
    Number(count) >= 2;
  const result = useQuery({
    queryKey: ['sample-size', params.toString()],
    queryFn: () => get<SampleSizeResult>(`/experiments/sample-size?${params}`),
    enabled: valid,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sample size calculator</CardTitle>
        <CardDescription>
          Decide the sample size before starting; stopping as soon as p &lt; 0.05 (peeking) inflates false
          positives.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="grid gap-1">
            <Label className="text-xs">Baseline conversion %</Label>
            <Input value={rate} onChange={(e) => setRate(e.target.value)} data-testid="ss-baseline" />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Relative MDE %</Label>
            <Input value={mde} onChange={(e) => setMde(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Power %</Label>
            <Input value={power} onChange={(e) => setPower(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Variations</Label>
            <Input value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
        </div>
        {result.data ? (
          <p className="text-sm" data-testid="ss-result">
            <b>{result.data.perVariation.toLocaleString()}</b> users per variation (
            <b>{result.data.total.toLocaleString()}</b> total) to detect{' '}
            {(result.data.baselineRate * 100).toFixed(2)}% → {(result.data.targetRate * 100).toFixed(2)}% at
            α={result.data.alpha}
            {Number(count) > 2 ? ' with Bonferroni correction' : ''}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
