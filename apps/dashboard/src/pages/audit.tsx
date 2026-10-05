import { jsonDiff } from '@ashamrai/flags-contracts';
import { Fragment, useState } from 'react';
import { JsonDiff } from '@/components/json-diff';
import { PageHeader, useProjectKey } from '@/components/layout';
import { Badge, Input, NativeSelect } from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useAudit, useProject } from '@/lib/queries';
import { formatDate } from '@/lib/utils';

export function AuditPage() {
  const project = useProjectKey();
  const { data: projectData } = useProject(project);
  const [filters, setFilters] = useState({ env: '', resource: '', actor: '', action: '' });
  const audit = useAudit(project, filters);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div>
      <PageHeader title="Audit log" description="Every change with author, intent and diff." />
      <div className="mb-4 flex flex-wrap gap-2">
        <NativeSelect value={filters.env} onChange={(e) => setFilters({ ...filters, env: e.target.value })}>
          <option value="">All environments</option>
          {projectData?.environments.map((e) => (
            <option key={e.key} value={e.key}>
              {e.name}
            </option>
          ))}
        </NativeSelect>
        <Input
          className="w-52"
          placeholder="Resource (flag key…)"
          value={filters.resource}
          onChange={(e) => setFilters({ ...filters, resource: e.target.value })}
          data-testid="audit-resource"
        />
        <Input
          className="w-44"
          placeholder="Actor"
          value={filters.actor}
          onChange={(e) => setFilters({ ...filters, actor: e.target.value })}
        />
        <Input
          className="w-56"
          placeholder="Action (flag.config.updated)"
          value={filters.action}
          onChange={(e) => setFilters({ ...filters, action: e.target.value })}
        />
      </div>
      <div className="rounded-xl border bg-card">
        <Table>
          <THead>
            <TR>
              <TH>When</TH>
              <TH>Who</TH>
              <TH>Action</TH>
              <TH>Resource</TH>
              <TH>What changed</TH>
            </TR>
          </THead>
          <TBody>
            {audit.data?.map((entry) => (
              <Fragment key={entry.id}>
                <TR
                  className="cursor-pointer"
                  onClick={() => setOpen(open === entry.id ? null : entry.id)}
                  data-testid="audit-row"
                >
                  <TD className="whitespace-nowrap text-xs">{formatDate(entry.createdAt)}</TD>
                  <TD>{entry.actor.name ?? 'system'}</TD>
                  <TD>
                    <Badge variant="outline">{entry.action}</Badge>
                  </TD>
                  <TD className="font-mono text-xs">
                    {entry.resource}
                    {entry.envKey ? <span className="text-muted-foreground"> · {entry.envKey}</span> : null}
                  </TD>
                  <TD className="max-w-lg text-sm">
                    {entry.descriptions.join('; ')}
                    {entry.comment ? (
                      <div className="text-xs italic text-muted-foreground">“{entry.comment}”</div>
                    ) : null}
                  </TD>
                </TR>
                {open === entry.id && (entry.before !== null || entry.after !== null) ? (
                  <TR>
                    <TD colSpan={5}>
                      <JsonDiff entries={jsonDiff(entry.before ?? undefined, entry.after ?? undefined)} />
                    </TD>
                  </TR>
                ) : null}
              </Fragment>
            ))}
          </TBody>
        </Table>
      </div>
    </div>
  );
}
