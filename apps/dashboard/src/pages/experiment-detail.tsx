import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, CheckCircle2, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectKey } from '@/components/layout';
import { SampleSizeCalculator } from '@/components/sample-size';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { errorMessage, post } from '@/lib/api';
import { keys, useExperiments, useResults } from '@/lib/queries';
import type { ExperimentResults } from '@/lib/types';
import { formatDate } from '@/lib/utils';

const pct = (v: number | undefined, digits = 2) => (v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | undefined, digits = 2) => (v === undefined ? '—' : v.toFixed(digits));

function CiBar({ low, high, scale }: { low: number; high: number; scale: number }) {
  const toX = (v: number) => 50 + (v / scale) * 50;
  const left = Math.max(0, Math.min(100, toX(low)));
  const right = Math.max(0, Math.min(100, toX(high)));
  const color = low > 0 ? 'bg-success' : high < 0 ? 'bg-destructive' : 'bg-muted-foreground';
  return (
    <div className="relative h-3 w-40 rounded bg-muted">
      <div className="absolute top-0 h-full w-px bg-foreground/40" style={{ left: '50%' }} />
      <div
        className={`absolute top-0.5 h-2 rounded ${color}`}
        style={{ left: `${left}%`, width: `${Math.max(1, right - left)}%` }}
      />
    </div>
  );
}

function MetricTable({ metric }: { metric: ExperimentResults['metrics'][number] }) {
  const scale = Math.max(
    1e-9,
    ...metric.variations.flatMap((v) => [Math.abs(v.ciLow ?? 0), Math.abs(v.ciHigh ?? 0)]),
  );
  return (
    <Card data-testid={`metric-${metric.metricKey}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {metric.metricName}{' '}
          <Badge variant="outline">
            {metric.kind === 'conversion' ? 'two-proportion z-test' : 'Welch t-test'}
          </Badge>
        </CardTitle>
        <CardDescription>
          Event “{metric.eventKey}” after the first exposure, 95% confidence intervals on the absolute
          difference vs control.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <THead>
            <TR>
              <TH>Variation</TH>
              <TH>Units</TH>
              <TH>{metric.kind === 'conversion' ? 'Conversion' : 'Mean'}</TH>
              <TH>Lift</TH>
              <TH>95% CI (difference)</TH>
              <TH>p-value</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {metric.variations.map((v) => (
              <TR key={v.variationId} data-testid={`result-${metric.metricKey}-${v.variationId}`}>
                <TD className="font-medium">
                  {v.variationName} {v.isControl ? <Badge variant="secondary">control</Badge> : null}
                </TD>
                <TD>{v.units.toLocaleString()}</TD>
                <TD>
                  {metric.kind === 'conversion'
                    ? `${pct(v.rate)} (${v.conversions?.toLocaleString()})`
                    : num(v.mean)}
                </TD>
                <TD
                  className={
                    v.isControl || !v.relativeLift
                      ? ''
                      : v.relativeLift > 0
                        ? 'text-success'
                        : 'text-destructive'
                  }
                >
                  {v.isControl ? '—' : `${(v.relativeLift ?? 0) > 0 ? '+' : ''}${pct(v.relativeLift, 1)}`}
                </TD>
                <TD>
                  {v.isControl ? null : (
                    <div className="flex items-center gap-2">
                      <CiBar low={v.ciLow ?? 0} high={v.ciHigh ?? 0} scale={scale} />
                      <span className="text-xs text-muted-foreground">
                        [{metric.kind === 'conversion' ? pct(v.ciLow) : num(v.ciLow)},{' '}
                        {metric.kind === 'conversion' ? pct(v.ciHigh) : num(v.ciHigh)}]
                      </span>
                    </div>
                  )}
                </TD>
                <TD>{v.isControl ? '' : v.pValue !== undefined ? v.pValue.toFixed(4) : ''}</TD>
                <TD>
                  {v.isControl ? null : v.significant ? (
                    <Badge variant={(v.relativeLift ?? 0) >= 0 ? 'success' : 'destructive'}>
                      {(v.relativeLift ?? 0) >= 0 ? 'significant win' : 'significant loss'}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">not significant</Badge>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function ExperimentDetailPage() {
  const project = useProjectKey();
  const { experiment: key } = useParams({ from: '/projects/$project/experiments/$experiment' });
  const experiments = useExperiments(project);
  const experiment = experiments.data?.find((x) => x.key === key);
  const results = useResults(experiment?.id ?? '', experiment?.status === 'running');
  const queryClient = useQueryClient();
  const transition = useMutation({
    mutationFn: (action: 'start' | 'stop') => post(`/experiments/${experiment!.id}/${action}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.experiments(project) });
      await queryClient.invalidateQueries({ queryKey: keys.results(experiment!.id) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  if (!experiment) return <Skeleton className="h-64" />;
  const data = results.data;
  const baselineRate =
    data?.metrics.find((m) => m.kind === 'conversion')?.variations.find((v) => v.isControl)?.rate || 0.1;
  return (
    <div className="grid gap-5">
      <Link
        to="/projects/$project/experiments"
        params={{ project }}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Experiments
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold" data-testid="experiment-title">
            {experiment.name}{' '}
            <Badge variant={experiment.status === 'running' ? 'success' : 'secondary'}>
              {experiment.status}
            </Badge>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Flag <span className="font-mono">{experiment.flagKey}</span> in {experiment.envKey} · started{' '}
            {formatDate(experiment.startedAt)}
          </p>
          {experiment.hypothesis ? <p className="mt-2 max-w-2xl text-sm">{experiment.hypothesis}</p> : null}
        </div>
        {experiment.status === 'running' ? (
          <Button variant="outline" onClick={() => transition.mutate('stop')}>
            <Square /> Stop
          </Button>
        ) : (
          <Button onClick={() => transition.mutate('start')}>
            <Play /> Start
          </Button>
        )}
      </div>
      {data ? (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Card>
              <CardContent className="pt-5">
                <div className="text-xs text-muted-foreground">Users in experiment</div>
                <div className="text-2xl font-semibold" data-testid="experiment-units">
                  {data.totalUnits.toLocaleString()}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {Object.entries(data.exposures)
                    .map(([id, n]) => `${id}: ${n.toLocaleString()}`)
                    .join(' · ')}
                </div>
              </CardContent>
            </Card>
            <Card data-testid="srm-card">
              <CardContent className="pt-5">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  Sample ratio mismatch check
                </div>
                {data.srm.mismatch ? (
                  <div
                    className="flex items-center gap-2 text-lg font-semibold text-destructive"
                    data-testid="srm-status"
                  >
                    <AlertTriangle className="size-5" /> Mismatch
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-2 text-lg font-semibold text-success"
                    data-testid="srm-status"
                  >
                    <CheckCircle2 className="size-5" /> SRM ok
                  </div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  χ² = {data.srm.chiSquare.toFixed(2)}, p = {data.srm.pValue.toFixed(4)} (alert below 0.001)
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <div className="text-xs text-muted-foreground">Planned sample size per variation</div>
                <div className="text-2xl font-semibold">
                  {data.sampleSize.requiredPerVariation?.toLocaleString() ?? '—'}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {data.sampleSize.reached ? 'reached' : 'not reached yet'}
                </div>
              </CardContent>
            </Card>
          </div>
          {data.warnings.map((w) => (
            <Alert key={w} variant={w.startsWith('Sample ratio') ? 'destructive' : 'warning'}>
              <AlertTriangle className="size-4" /> {w}
            </Alert>
          ))}
          {data.metrics.map((m) => (
            <MetricTable key={m.metricKey} metric={m} />
          ))}
        </>
      ) : (
        <Skeleton className="h-64" />
      )}
      <SampleSizeCalculator
        key={baselineRate.toFixed(4)}
        variants={experiment.variations.length}
        baseline={baselineRate}
      />
    </div>
  );
}
