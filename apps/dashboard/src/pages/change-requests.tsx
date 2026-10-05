import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Play, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { JsonDiff } from '@/components/json-diff';
import { PageHeader, useProjectKey } from '@/components/layout';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  NativeSelect,
  Textarea,
} from '@/components/ui/primitives';
import { errorMessage, post } from '@/lib/api';
import { keys, useChangeRequest, useChangeRequests, useMe } from '@/lib/queries';
import type { ChangeRequest } from '@/lib/types';
import { relativeTime } from '@/lib/utils';

const STATUS: Record<
  ChangeRequest['status'],
  'warning' | 'success' | 'destructive' | 'default' | 'secondary'
> = {
  pending: 'warning',
  approved: 'default',
  applied: 'success',
  rejected: 'secondary',
  failed: 'destructive',
};

export function ChangeRequestsPage() {
  const project = useProjectKey();
  const search = useSearch({ from: '/projects/$project/change-requests' });
  const navigate = useNavigate();
  const list = useChangeRequests(project);
  const [status, setStatus] = useState('');
  const selectedId = search.id ?? list.data?.[0]?.id ?? '';
  const items = (list.data ?? []).filter((cr) => !status || cr.status === status);
  return (
    <div>
      <PageHeader
        title="Change requests"
        description="Changes to protected environments wait for a reviewer."
        actions={
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {Object.keys(STATUS).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </NativeSelect>
        }
      />
      {items.length === 0 ? (
        <EmptyState title="No change requests" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
          <div className="grid content-start gap-2">
            {items.map((cr) => (
              <button
                key={cr.id}
                data-testid={`cr-${cr.id}`}
                onClick={() =>
                  void navigate({
                    to: '/projects/$project/change-requests',
                    params: { project },
                    search: { id: cr.id },
                  })
                }
                className={`rounded-lg border p-3 text-left text-sm transition-colors ${cr.id === selectedId ? 'border-primary bg-primary/5' : 'bg-card hover:bg-accent'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{cr.flagKey}</span>
                  <Badge variant={STATUS[cr.status]}>{cr.status}</Badge>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {cr.descriptions.join(' · ')}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {cr.envKey} · {cr.author?.name} · {relativeTime(cr.createdAt)}
                </div>
              </button>
            ))}
          </div>
          {selectedId ? <ChangeRequestDetail id={selectedId} project={project} /> : null}
        </div>
      )}
    </div>
  );
}

function ChangeRequestDetail({ id, project }: { id: string; project: string }) {
  const cr = useChangeRequest(id);
  const me = useMe();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const act = useMutation({
    mutationFn: (action: 'approve' | 'reject' | 'apply') =>
      post(`/change-requests/${id}/${action}`, action === 'apply' ? {} : { comment: comment || undefined }),
    onSuccess: async (_, action) => {
      toast.success(
        `Change request ${action === 'apply' ? 'applied' : action === 'approve' ? 'approved' : 'rejected'}`,
      );
      setComment('');
      await queryClient.invalidateQueries({ queryKey: keys.changeRequest(id) });
      await queryClient.invalidateQueries({ queryKey: keys.changeRequests(project) });
      await queryClient.invalidateQueries({ queryKey: keys.flags(project) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  if (!cr.data) return null;
  const data = cr.data;
  const isAuthor = data.author?.id === me.data?.id;
  return (
    <Card data-testid="cr-detail">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {data.flagKey} in {data.envKey} <Badge variant={STATUS[data.status]}>{data.status}</Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Requested by {data.author?.name} {relativeTime(data.createdAt)} on version {data.baseVersion}
          {data.currentVersion !== undefined && data.currentVersion !== data.baseVersion
            ? ` (now v${data.currentVersion}: the semantic patch will be re-applied on top)`
            : ''}
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {data.comment ? (
          <blockquote className="border-l-2 pl-3 text-sm italic">{data.comment}</blockquote>
        ) : null}
        <ol className="list-decimal pl-5 text-sm">
          {data.descriptions.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ol>
        {data.previewError ? (
          <Alert variant="destructive">This change no longer applies: {data.previewError}</Alert>
        ) : null}
        {data.preview ? <JsonDiff entries={data.preview.diff} /> : null}
        {data.reviewer ? (
          <p className="text-sm text-muted-foreground">
            Reviewed by {data.reviewer.name}
            {data.reviewComment ? `: “${data.reviewComment}”` : ''}
          </p>
        ) : null}
        {data.error ? <Alert variant="destructive">{data.error}</Alert> : null}
        {data.status === 'pending' ? (
          <>
            <Textarea
              placeholder="Review comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                onClick={() => act.mutate('approve')}
                disabled={isAuthor || act.isPending}
                title={isAuthor ? 'Authors cannot approve their own requests' : ''}
                data-testid="cr-approve"
              >
                <Check /> Approve
              </Button>
              <Button
                variant="outline"
                onClick={() => act.mutate('reject')}
                disabled={act.isPending}
                data-testid="cr-reject"
              >
                <X /> Reject
              </Button>
            </div>
          </>
        ) : null}
        {data.status === 'approved' ? (
          <Button
            className="w-fit"
            onClick={() => act.mutate('apply')}
            disabled={act.isPending}
            data-testid="cr-apply"
          >
            <Play /> Apply change
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
