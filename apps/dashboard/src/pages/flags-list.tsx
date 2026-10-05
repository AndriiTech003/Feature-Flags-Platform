import { Link } from '@tanstack/react-router';
import { Archive, Clock, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CreateFlagDialog } from '@/components/create-flag-dialog';
import { FlagToggle } from '@/components/flag-toggle';
import { PageHeader, useProjectKey } from '@/components/layout';
import { Badge, EmptyState, Input, NativeSelect, Skeleton } from '@/components/ui/primitives';
import { Tooltip } from '@/components/ui/overlays';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useFlags, useProject } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

export function FlagsListPage() {
  const project = useProjectKey();
  const { data: projectData } = useProject(project);
  const flags = useFlags(project);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [lifecycle, setLifecycle] = useState('active');
  const tags = useMemo(
    () => Array.from(new Set(flags.data?.flatMap((f) => f.tags) ?? [])).sort(),
    [flags.data],
  );
  const visible = (flags.data ?? []).filter((flag) => {
    if (lifecycle === 'archived' ? !flag.archivedAt : flag.archivedAt) return false;
    if (lifecycle === 'temporary' && !flag.temporary) return false;
    if (lifecycle === 'permanent' && flag.temporary) return false;
    if (lifecycle === 'stale' && !flag.stale) return false;
    if (tag && !flag.tags.includes(tag)) return false;
    const q = query.trim().toLowerCase();
    return (
      !q ||
      flag.key.includes(q) ||
      flag.name.toLowerCase().includes(q) ||
      (flag.description ?? '').toLowerCase().includes(q)
    );
  });
  const envs = projectData?.environments ?? [];
  return (
    <div>
      <PageHeader
        title="Feature flags"
        description={`${projectData?.name ?? project} · ${flags.data?.filter((f) => !f.archivedAt).length ?? 0} active flags`}
        actions={<CreateFlagDialog project={project} />}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            data-testid="flag-search"
            className="pl-8"
            placeholder="Search flags"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <NativeSelect value={tag} onChange={(e) => setTag(e.target.value)} data-testid="tag-filter">
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          value={lifecycle}
          onChange={(e) => setLifecycle(e.target.value)}
          data-testid="lifecycle-filter"
        >
          <option value="active">Active</option>
          <option value="temporary">Temporary</option>
          <option value="permanent">Permanent</option>
          <option value="stale">Stale (not evaluated 30 days)</option>
          <option value="archived">Archived</option>
        </NativeSelect>
      </div>
      {flags.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : visible.length === 0 ? (
        <EmptyState title="No flags match" description="Try a different filter or create a new flag." />
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <THead>
              <TR>
                <TH>Flag</TH>
                <TH>Tags</TH>
                {envs.map((env) => (
                  <TH key={env.key} className="text-center">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: env.color }} />
                      {env.name}
                    </span>
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {visible.map((flag) => (
                <TR key={flag.key} data-testid={`flag-row-${flag.key}`}>
                  <TD>
                    <Link
                      to="/projects/$project/flags/$flag"
                      params={{ project, flag: flag.key }}
                      className="group block"
                    >
                      <div className="flex items-center gap-2 font-medium group-hover:text-primary">
                        {flag.name}
                        {flag.archivedAt ? (
                          <Badge variant="secondary">
                            <Archive className="size-3" /> archived
                          </Badge>
                        ) : null}
                        {flag.stale && !flag.archivedAt ? (
                          <Tooltip content="Not evaluated in any environment for 30 days: consider removing it">
                            <Badge variant="warning" data-testid={`stale-${flag.key}`}>
                              <Clock className="size-3" /> stale
                            </Badge>
                          </Tooltip>
                        ) : null}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {flag.key} · {flag.kind}
                        {flag.temporary ? ' · temporary' : ''}
                      </div>
                    </Link>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {flag.tags.map((t) => (
                        <Badge key={t} variant="outline">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                  {envs.map((env) => {
                    const state = flag.environments[env.key];
                    return (
                      <TD key={env.key} className="text-center">
                        {state && !flag.archivedAt ? (
                          <div className="flex flex-col items-center gap-1">
                            <FlagToggle
                              project={project}
                              flagKey={flag.key}
                              env={env}
                              on={state.on}
                              version={state.version}
                            />
                            <span
                              className={`text-[11px] ${state.stale ? 'text-amber-600' : 'text-muted-foreground'}`}
                            >
                              {relativeTime(state.lastEvaluatedAt)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TD>
                    );
                  })}
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
