import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PageHeader, useProjectKey } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState } from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { del, errorMessage } from '@/lib/api';
import { keys, useScheduled } from '@/lib/queries';
import { formatDate, relativeTime } from '@/lib/utils';

export function ScheduledPage() {
  const project = useProjectKey();
  const list = useScheduled(project);
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: string) => del(`/scheduled-changes/${id}`),
    onSuccess: async () => {
      toast.success('Scheduled change cancelled');
      await queryClient.invalidateQueries({ queryKey: keys.scheduled(project) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div>
      <PageHeader
        title="Scheduled changes"
        description="Changes executed by the worker at a given time, for example “raise to 50% on Friday 10:00”."
      />
      {list.data?.length === 0 ? (
        <EmptyState
          title="Nothing scheduled"
          description="Use “Schedule” in the pending changes bar of a flag."
        />
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Flag</TH>
                <TH>Environment</TH>
                <TH>Changes</TH>
                <TH>Status</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {list.data?.map((s) => (
                <TR key={s.id}>
                  <TD>
                    <div>{formatDate(s.executeAt)}</div>
                    <div className="text-xs text-muted-foreground">{relativeTime(s.executeAt)}</div>
                  </TD>
                  <TD className="font-medium">{s.flagKey}</TD>
                  <TD>{s.envKey}</TD>
                  <TD className="max-w-md text-sm">
                    {s.descriptions.join('; ')}
                    {s.comment ? <div className="text-xs text-muted-foreground">{s.comment}</div> : null}
                    {s.error ? <div className="text-xs text-destructive">{s.error}</div> : null}
                  </TD>
                  <TD>
                    <Badge
                      variant={
                        s.status === 'executed'
                          ? 'success'
                          : s.status === 'failed'
                            ? 'destructive'
                            : s.status === 'pending'
                              ? 'warning'
                              : 'secondary'
                      }
                    >
                      {s.status}
                    </Badge>
                  </TD>
                  <TD>
                    {s.status === 'pending' ? (
                      <Button size="sm" variant="ghost" onClick={() => cancel.mutate(s.id)}>
                        Cancel
                      </Button>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
