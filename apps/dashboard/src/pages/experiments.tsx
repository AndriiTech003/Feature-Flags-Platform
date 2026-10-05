import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader, useProjectKey } from '@/components/layout';
import { SampleSizeCalculator } from '@/components/sample-size';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  Input,
  Label,
  NativeSelect,
  Textarea,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { errorMessage, post } from '@/lib/api';
import { keys, useExperiments, useFlags, useMetrics, useProject } from '@/lib/queries';
import { formatDate } from '@/lib/utils';

export function ExperimentsPage() {
  const project = useProjectKey();
  const experiments = useExperiments(project);
  const metrics = useMetrics(project);
  const flags = useFlags(project);
  const { data: projectData } = useProject(project);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [metricOpen, setMetricOpen] = useState(false);
  const [form, setForm] = useState({
    key: '',
    name: '',
    hypothesis: '',
    flagKey: '',
    envKey: 'production',
    metricKeys: [] as string[],
    controlVariationId: '',
    minimumSampleSize: '',
  });
  const [metric, setMetric] = useState({ key: '', name: '', eventKey: '', kind: 'conversion', unit: '' });
  const create = useMutation({
    mutationFn: () =>
      post(`/projects/${project}/experiments`, {
        ...form,
        hypothesis: form.hypothesis || undefined,
        controlVariationId: form.controlVariationId || undefined,
        minimumSampleSize: form.minimumSampleSize ? Number(form.minimumSampleSize) : undefined,
      }),
    onSuccess: async () => {
      toast.success('Experiment created');
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: keys.experiments(project) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const createMetric = useMutation({
    mutationFn: () => post(`/projects/${project}/metrics`, { ...metric, unit: metric.unit || undefined }),
    onSuccess: async () => {
      toast.success('Metric created');
      setMetricOpen(false);
      await queryClient.invalidateQueries({ queryKey: keys.metrics(project) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const selectedFlag = flags.data?.find((f) => f.key === form.flagKey);
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Experiments"
        description="Rollouts measured against metrics: two-proportion z-test, Welch t-test, confidence intervals and SRM checks."
        actions={
          <>
            <Button variant="outline" onClick={() => setMetricOpen(true)}>
              <Plus /> Metric
            </Button>
            <Button onClick={() => setOpen(true)} data-testid="new-experiment">
              <Plus /> Experiment
            </Button>
          </>
        }
      />
      {experiments.data?.length === 0 ? <EmptyState title="No experiments yet" /> : null}
      {experiments.data?.length ? (
        <div className="rounded-xl border bg-card">
          <Table>
            <THead>
              <TR>
                <TH>Experiment</TH>
                <TH>Flag</TH>
                <TH>Environment</TH>
                <TH>Metrics</TH>
                <TH>Status</TH>
                <TH>Started</TH>
              </TR>
            </THead>
            <TBody>
              {experiments.data.map((x) => (
                <TR key={x.id}>
                  <TD>
                    <Link
                      to="/projects/$project/experiments/$experiment"
                      params={{ project, experiment: x.key }}
                      className="font-medium hover:text-primary"
                      data-testid={`experiment-${x.key}`}
                    >
                      {x.name}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">{x.key}</div>
                  </TD>
                  <TD className="font-mono text-xs">{x.flagKey}</TD>
                  <TD>{x.envKey}</TD>
                  <TD>{x.metrics.map((m) => m.name).join(', ')}</TD>
                  <TD>
                    <Badge
                      variant={
                        x.status === 'running' ? 'success' : x.status === 'draft' ? 'secondary' : 'outline'
                      }
                    >
                      {x.status}
                    </Badge>
                  </TD>
                  <TD className="text-xs">{formatDate(x.startedAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Metrics</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {metrics.data?.map((m) => (
              <div key={m.key} className="flex items-center gap-2">
                <Badge variant="outline">{m.kind}</Badge>
                <span className="font-medium">{m.name}</span>
                <span className="font-mono text-xs text-muted-foreground">event: {m.eventKey}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <SampleSizeCalculator />
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader
            title="New experiment"
            description="The flag needs a percentage rollout in the chosen environment."
          />
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      name: e.target.value,
                      key: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, ''),
                    })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Key</Label>
                <Input
                  className="font-mono"
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                />
              </div>
            </div>
            <Textarea
              placeholder="Hypothesis"
              value={form.hypothesis}
              onChange={(e) => setForm({ ...form, hypothesis: e.target.value })}
            />
            <div className="grid grid-cols-3 gap-3">
              <NativeSelect
                value={form.flagKey}
                onChange={(e) => setForm({ ...form, flagKey: e.target.value, controlVariationId: '' })}
              >
                <option value="">Flag…</option>
                {flags.data
                  ?.filter((f) => !f.archivedAt)
                  .map((f) => (
                    <option key={f.key}>{f.key}</option>
                  ))}
              </NativeSelect>
              <NativeSelect
                value={form.envKey}
                onChange={(e) => setForm({ ...form, envKey: e.target.value })}
              >
                {projectData?.environments.map((e) => (
                  <option key={e.key} value={e.key}>
                    {e.name}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                value={form.controlVariationId}
                onChange={(e) => setForm({ ...form, controlVariationId: e.target.value })}
              >
                <option value="">Control: first</option>
                {selectedFlag?.variations.map((v) => (
                  <option key={v.id} value={v.id}>
                    Control: {v.name ?? v.id}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label>Metrics</Label>
              {metrics.data?.map((m) => (
                <label key={m.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.metricKeys.includes(m.key)}
                    onCheckedChange={(v) =>
                      setForm({
                        ...form,
                        metricKeys:
                          v === true
                            ? [...form.metricKeys, m.key]
                            : form.metricKeys.filter((k) => k !== m.key),
                      })
                    }
                  />
                  {m.name}
                </label>
              ))}
            </div>
            <Input
              placeholder="Planned sample size per variation (optional)"
              value={form.minimumSampleSize}
              onChange={(e) => setForm({ ...form, minimumSampleSize: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() => create.mutate()}
              disabled={create.isPending || !form.flagKey || form.metricKeys.length === 0}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={metricOpen} onOpenChange={setMetricOpen}>
        <DialogContent>
          <DialogHeader title="New metric" description="Metrics count custom events sent with track()." />
          <div className="grid gap-3">
            <Input
              placeholder="Name"
              value={metric.name}
              onChange={(e) =>
                setMetric({
                  ...metric,
                  name: e.target.value,
                  key: e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, ''),
                })
              }
            />
            <Input
              placeholder="Event key (e.g. purchase)"
              value={metric.eventKey}
              onChange={(e) => setMetric({ ...metric, eventKey: e.target.value })}
            />
            <NativeSelect
              value={metric.kind}
              onChange={(e) => setMetric({ ...metric, kind: e.target.value })}
            >
              <option value="conversion">Conversion (did the event happen)</option>
              <option value="numeric">Numeric (sum of event values per user)</option>
            </NativeSelect>
            <Input
              placeholder="Unit (optional)"
              value={metric.unit}
              onChange={(e) => setMetric({ ...metric, unit: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => createMetric.mutate()} disabled={createMetric.isPending}>
              Create metric
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
