import { instructionsBetween, type Instruction } from '@ashamrai/flags-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, FlaskConical, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FlagToggle } from '@/components/flag-toggle';
import { InsightsChart } from '@/components/insights-chart';
import { useRealtime } from '@/components/layout';
import { PendingBar } from '@/components/pending-bar';
import { Playground } from '@/components/playground';
import { RuleEditor } from '@/components/rule-editor';
import { ServeEditor, variationLabel } from '@/components/serve-editor';
import { TargetsEditor } from '@/components/targets-editor';
import { FlagSettings } from '@/components/flag-settings';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  NativeSelect,
  Skeleton,
} from '@/components/ui/primitives';
import { ApiError, errorMessage, patch, post } from '@/lib/api';
import {
  keys,
  useAttributes,
  useFlag,
  useInsights,
  useMe,
  useProject,
  useRuleset,
  useSegments,
} from '@/lib/queries';
import type { FlagConfig } from '@/lib/types';
import { formatDate } from '@/lib/utils';

function patchable(config: FlagConfig) {
  return {
    on: config.on,
    offVariation: config.offVariation,
    targets: config.targets,
    rules: config.rules,
    fallthrough: config.fallthrough,
  };
}

export function FlagDetailPage() {
  const { project, flag: flagKey } = useParams({ from: '/projects/$project/flags/$flag' });
  const search = useSearch({ from: '/projects/$project/flags/$flag' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe();
  const { data: projectData } = useProject(project);
  const flag = useFlag(project, flagKey);
  const envs = projectData?.environments ?? [];
  const envKey = search.env ?? (envs.find((e) => e.key === 'production') ?? envs[0])?.key ?? 'production';
  const env = envs.find((e) => e.key === envKey);
  const tab = search.tab ?? 'targeting';
  const config = flag.data?.environments[envKey];
  const [draft, setDraft] = useState<FlagConfig | null>(null);
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const ruleset = useRuleset(project, envKey);
  const attributes = useAttributes(project, envKey);
  const segments = useSegments(project, envKey);
  const insights = useInsights(project, flagKey, envKey);

  useEffect(() => {
    setDraft(null);
    setUpdatedBy(null);
    setConflict(false);
  }, [envKey, flagKey]);

  useRealtime((n) => {
    if (n.flagKey !== flagKey || n.envKey !== envKey) return;
    if (n.actor && me.data && n.actor.id === me.data.id) return;
    setUpdatedBy(n.actor?.name ?? 'the scheduler');
  });

  const current = draft ?? config;
  const instructions: Instruction[] = useMemo(
    () => (config && current ? instructionsBetween(patchable(config), patchable(current)) : []),
    [config, current],
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.flag(project, flagKey) });
    await queryClient.invalidateQueries({ queryKey: keys.ruleset(project, envKey) });
    await queryClient.invalidateQueries({ queryKey: keys.flags(project) });
  };

  const save = useMutation({
    mutationFn: (comment: string) =>
      patch(
        `/projects/${project}/flags/${flagKey}/envs/${envKey}`,
        { instructions, comment: comment || undefined },
        { 'if-match': `"${config!.version}"` },
      ),
    onSuccess: async () => {
      toast.success('Changes saved');
      setDraft(null);
      setConflict(false);
      await refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      toast.error(errorMessage(error));
    },
  });
  const requestApproval = useMutation({
    mutationFn: (comment: string) =>
      post<{ id: string }>(`/projects/${project}/flags/${flagKey}/envs/${envKey}/change-requests`, {
        instructions,
        comment: comment || undefined,
      }),
    onSuccess: async (cr) => {
      toast.success('Change request created', {
        action: {
          label: 'Open',
          onClick: () =>
            void navigate({
              to: '/projects/$project/change-requests',
              params: { project },
              search: { id: cr.id },
            }),
        },
      });
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: keys.changeRequests(project) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const schedule = useMutation({
    mutationFn: ({ executeAt, comment }: { executeAt: string; comment: string }) =>
      post(`/projects/${project}/flags/${flagKey}/envs/${envKey}/schedule`, {
        instructions,
        executeAt,
        comment: comment || undefined,
      }),
    onSuccess: async () => {
      toast.success('Change scheduled');
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: keys.scheduled(project) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (flag.isLoading || !projectData) return <Skeleton className="h-96 w-full" />;
  if (!flag.data) return <Alert variant="destructive">Flag {flagKey} not found.</Alert>;
  const data = flag.data;
  const update = (partial: Partial<FlagConfig>) => setDraft({ ...(current as FlagConfig), ...partial });

  return (
    <div className="pb-24">
      <Link
        to="/projects/$project/flags"
        params={{ project }}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All flags
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            className="flex items-center gap-2 text-2xl font-semibold tracking-tight"
            data-testid="flag-title"
          >
            {data.name}
            <Badge variant="secondary">{data.kind}</Badge>
            {data.archivedAt ? <Badge variant="destructive">archived</Badge> : null}
          </h1>
          <div className="mt-1 font-mono text-sm text-muted-foreground">{data.key}</div>
          {data.description ? (
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{data.description}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {data.tags.map((t) => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
          </div>
        </div>
        {config && env ? (
          <FlagToggle
            project={project}
            flagKey={flagKey}
            env={env}
            on={config.on}
            version={config.version}
            size="lg"
          />
        ) : null}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Environments">
        {envs.map((e) => (
          <button
            key={e.key}
            data-testid={`env-tab-${e.key}`}
            onClick={() =>
              void navigate({
                to: '/projects/$project/flags/$flag',
                params: { project, flag: flagKey },
                search: { env: e.key, tab },
              })
            }
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors ${e.key === envKey ? 'border-primary bg-primary/5 font-medium' : 'bg-card hover:bg-accent'}`}
          >
            <span className="size-2 rounded-full" style={{ background: e.color }} />
            {e.name}
            <span
              className={`text-xs ${data.environments[e.key]?.on ? 'text-success' : 'text-muted-foreground'}`}
            >
              {data.environments[e.key]?.on ? 'on' : 'off'}
            </span>
            {e.requireApproval ? <Badge variant="warning">approval</Badge> : null}
          </button>
        ))}
      </div>

      {updatedBy ? (
        <Alert variant="info" className="mb-4 items-center justify-between" data-testid="updated-banner">
          <span>
            Flag was updated by <b>{updatedBy}</b>
            {draft ? ' while you have unsaved changes.' : '.'}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              setUpdatedBy(null);
              setDraft(null);
              setConflict(false);
              await refresh();
            }}
          >
            <RefreshCw /> Reload
          </Button>
        </Alert>
      ) : null}
      {conflict ? (
        <Alert variant="destructive" className="mb-4 items-center justify-between">
          <span>
            Someone saved this flag after you started editing (version conflict). Reload to see their changes.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              setConflict(false);
              setDraft(null);
              await refresh();
            }}
          >
            Reload
          </Button>
        </Alert>
      ) : null}
      {config?.experiment ? (
        <Alert variant="info" className="mb-4">
          <FlaskConical className="size-4" /> Experiment <b>{config.experiment.key}</b> is running on this
          flag in {env?.name}. Rollouts in this environment count towards it.
        </Alert>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({
            to: '/projects/$project/flags/$flag',
            params: { project, flag: flagKey },
            search: { env: envKey, tab: value },
          })
        }
      >
        <TabsList>
          <TabsTrigger value="targeting" data-testid="tab-targeting">
            Targeting
          </TabsTrigger>
          <TabsTrigger value="playground" data-testid="tab-playground">
            Evaluate playground
          </TabsTrigger>
          <TabsTrigger value="insights" data-testid="tab-insights">
            Insights
          </TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">
            Settings
          </TabsTrigger>
        </TabsList>
        <TabsContent value="targeting">
          {current ? (
            <div className="grid gap-4">
              {data.prerequisites.length > 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Prerequisites</CardTitle>
                    <CardDescription>All must pass before targeting is evaluated.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    {data.prerequisites.map((p) => (
                      <Badge key={p.flagKey} variant="outline">
                        {p.flagKey} = {p.variationId}
                      </Badge>
                    ))}
                  </CardContent>
                </Card>
              ) : null}
              <Card>
                <CardHeader>
                  <CardTitle>Individual targets</CardTitle>
                  <CardDescription>
                    Specific context keys always get a variation, before any rule.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <TargetsEditor
                    targets={current.targets}
                    variations={data.variations}
                    onChange={(targets) => update({ targets })}
                  />
                </CardContent>
              </Card>
              <div>
                <h2 className="mb-2 font-semibold">Rules</h2>
                <p className="mb-3 text-sm text-muted-foreground">
                  Evaluated top to bottom, the first match wins. Drag to reorder.
                </p>
                <RuleEditor
                  rules={current.rules}
                  variations={data.variations}
                  attributes={(attributes.data ?? []).map((a) => (a.kind === 'user' ? a.name : `${a.name}`))}
                  segments={(segments.data ?? []).map((s) => s.key)}
                  onChange={(rules) => update({ rules })}
                />
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>Default rule</CardTitle>
                  <CardDescription>Served when targeting is on and no rule matched.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ServeEditor
                    testId="fallthrough"
                    serve={current.fallthrough}
                    variations={data.variations}
                    onChange={(fallthrough) => update({ fallthrough })}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Off variation</CardTitle>
                  <CardDescription>Served when targeting is off or a prerequisite fails.</CardDescription>
                </CardHeader>
                <CardContent>
                  <NativeSelect
                    value={current.offVariation ?? ''}
                    onChange={(e) => update({ offVariation: e.target.value || null })}
                    data-testid="off-variation"
                  >
                    {data.variations.map((v) => (
                      <option key={v.id} value={v.id}>
                        {variationLabel(data.variations, v.id)}
                      </option>
                    ))}
                    <option value="">SDK default value</option>
                  </NativeSelect>
                </CardContent>
              </Card>
              <p className="text-xs text-muted-foreground">
                Version {config?.version} · updated {formatDate(config?.updatedAt)}
              </p>
            </div>
          ) : (
            <Skeleton className="h-64" />
          )}
        </TabsContent>
        <TabsContent value="playground">
          {config && current ? (
            <Playground
              flagKey={flagKey}
              ruleset={ruleset.data}
              draft={current}
              original={config}
              variations={data.variations}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="insights">
          <InsightsChart insights={insights.data} variations={data.variations} />
        </TabsContent>
        <TabsContent value="settings">
          <FlagSettings project={project} flag={data} />
        </TabsContent>
      </Tabs>

      {config && current ? (
        <PendingBar
          instructions={instructions}
          before={patchable(config)}
          after={patchable(current)}
          variations={data.variations}
          requireApproval={env?.requireApproval ?? false}
          envName={env?.name ?? envKey}
          busy={save.isPending || requestApproval.isPending || schedule.isPending}
          onDiscard={() => setDraft(null)}
          onSave={(comment) => save.mutate(comment)}
          onRequestApproval={(comment) => requestApproval.mutate(comment)}
          onSchedule={(executeAt, comment) => schedule.mutate({ executeAt, comment })}
        />
      ) : null}
    </div>
  );
}
