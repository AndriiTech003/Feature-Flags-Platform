import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import type {
  AuditEntry,
  ChangeRequest,
  CompareResult,
  Experiment,
  ExperimentResults,
  FlagDetail,
  FlagInsights,
  FlagListItem,
  Me,
  Member,
  Metric,
  Project,
  ScheduledChange,
  SdkKey,
  Segment,
  Webhook,
} from './types';

export const keys = {
  me: ['me'] as const,
  projects: ['projects'] as const,
  flags: (p: string) => ['flags', p] as const,
  flag: (p: string, f: string) => ['flag', p, f] as const,
  insights: (p: string, f: string, env: string) => ['insights', p, f, env] as const,
  ruleset: (p: string, env: string) => ['ruleset', p, env] as const,
  attributes: (p: string, env: string) => ['attributes', p, env] as const,
  segments: (p: string, env: string) => ['segments', p, env] as const,
  changeRequests: (p: string) => ['change-requests', p] as const,
  changeRequest: (id: string) => ['change-request', id] as const,
  scheduled: (p: string) => ['scheduled', p] as const,
  audit: (p: string, filters: string) => ['audit', p, filters] as const,
  sdkKeys: (p: string, env: string) => ['sdk-keys', p, env] as const,
  metrics: (p: string) => ['metrics', p] as const,
  experiments: (p: string) => ['experiments', p] as const,
  results: (id: string) => ['results', id] as const,
  webhooks: ['webhooks'] as const,
  members: (org: string) => ['members', org] as const,
  compare: (p: string) => ['compare', p] as const,
};

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => get<Me>('/auth/me') });
export const useProjects = () =>
  useQuery({
    queryKey: keys.projects,
    queryFn: async () => (await get<{ items: Project[] }>('/projects')).items,
  });
export function useProject(projectKey: string) {
  const projects = useProjects();
  return { ...projects, data: projects.data?.find((p) => p.key === projectKey) };
}
export const useFlags = (p: string) =>
  useQuery({
    queryKey: keys.flags(p),
    queryFn: async () => (await get<{ items: FlagListItem[] }>(`/projects/${p}/flags?archived=all`)).items,
  });
export const useFlag = (p: string, f: string) =>
  useQuery({ queryKey: keys.flag(p, f), queryFn: () => get<FlagDetail>(`/projects/${p}/flags/${f}`) });
export const useInsights = (p: string, f: string, env: string) =>
  useQuery({
    queryKey: keys.insights(p, f, env),
    queryFn: () => get<FlagInsights>(`/projects/${p}/flags/${f}/insights?env=${env}`),
    refetchInterval: 30000,
  });
export const useRuleset = (p: string, env: string) =>
  useQuery({
    queryKey: keys.ruleset(p, env),
    queryFn: () => get<import('@ashamrai/flags-evaluator').Ruleset>(`/projects/${p}/envs/${env}/ruleset`),
  });
export const useAttributes = (p: string, env: string) =>
  useQuery({
    queryKey: keys.attributes(p, env),
    queryFn: async () =>
      (
        await get<{ items: Array<{ kind: string; name: string }> }>(
          `/projects/${p}/context-attributes?env=${env}`,
        )
      ).items,
  });
export const useSegments = (p: string, env: string) =>
  useQuery({
    queryKey: keys.segments(p, env),
    queryFn: async () => (await get<{ items: Segment[] }>(`/projects/${p}/envs/${env}/segments`)).items,
  });
export const useChangeRequests = (p: string) =>
  useQuery({
    queryKey: keys.changeRequests(p),
    queryFn: async () => (await get<{ items: ChangeRequest[] }>(`/projects/${p}/change-requests`)).items,
  });
export const useChangeRequest = (id: string) =>
  useQuery({
    queryKey: keys.changeRequest(id),
    queryFn: () => get<ChangeRequest>(`/change-requests/${id}`),
    enabled: !!id,
  });
export const useScheduled = (p: string) =>
  useQuery({
    queryKey: keys.scheduled(p),
    queryFn: async () => (await get<{ items: ScheduledChange[] }>(`/projects/${p}/scheduled-changes`)).items,
  });
export const useAudit = (p: string, filters: Record<string, string>) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  return useQuery({
    queryKey: keys.audit(p, query),
    queryFn: async () => (await get<{ items: AuditEntry[] }>(`/projects/${p}/audit-log?${query}`)).items,
  });
};
export const useSdkKeys = (p: string, env: string) =>
  useQuery({
    queryKey: keys.sdkKeys(p, env),
    queryFn: async () => (await get<{ items: SdkKey[] }>(`/projects/${p}/envs/${env}/sdk-keys`)).items,
  });
export const useMetrics = (p: string) =>
  useQuery({
    queryKey: keys.metrics(p),
    queryFn: async () => (await get<{ items: Metric[] }>(`/projects/${p}/metrics`)).items,
  });
export const useExperiments = (p: string) =>
  useQuery({
    queryKey: keys.experiments(p),
    queryFn: async () => (await get<{ items: Experiment[] }>(`/projects/${p}/experiments`)).items,
  });
export const useResults = (id: string, running: boolean) =>
  useQuery({
    queryKey: keys.results(id),
    queryFn: () => get<ExperimentResults>(`/experiments/${id}/results`),
    refetchInterval: running ? 10000 : false,
  });
export const useWebhooks = () =>
  useQuery({
    queryKey: keys.webhooks,
    queryFn: async () => (await get<{ items: Webhook[] }>('/webhooks')).items,
  });
export const useMembers = (org: string) =>
  useQuery({
    queryKey: keys.members(org),
    queryFn: async () => (await get<{ items: Member[] }>(`/orgs/${org}/members`)).items,
    enabled: !!org,
  });
export const useCompare = (p: string) =>
  useQuery({ queryKey: keys.compare(p), queryFn: () => get<CompareResult>(`/projects/${p}/compare`) });
