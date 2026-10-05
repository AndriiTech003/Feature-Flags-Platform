import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Copy, KeyRound, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader, useProjectKey } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { Alert, Badge, Input, Label, NativeSelect } from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { del, errorMessage, post } from '@/lib/api';
import { keys, useProject, useSdkKeys } from '@/lib/queries';
import type { SdkKey } from '@/lib/types';
import { formatDate } from '@/lib/utils';

export function SdkKeysPage() {
  const project = useProjectKey();
  const search = useSearch({ from: '/projects/$project/sdk-keys' });
  const navigate = useNavigate();
  const { data: projectData } = useProject(project);
  const env = search.env ?? 'production';
  const list = useSdkKeys(project, env);
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [rotating, setRotating] = useState<SdkKey | null>(null);
  const [grace, setGrace] = useState('1440');
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.sdkKeys(project, env) });
  const create = useMutation({
    mutationFn: (kind: 'server' | 'client') =>
      post<SdkKey>(`/projects/${project}/envs/${env}/sdk-keys`, { kind }),
    onSuccess: async (key) => {
      setRevealed(key.key ?? null);
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const rotate = useMutation({
    mutationFn: (key: SdkKey) =>
      post<{ current: SdkKey }>(`/projects/${project}/envs/${env}/sdk-keys/${key.id}/rotate`, {
        gracePeriodMinutes: Number(grace),
      }),
    onSuccess: async (result) => {
      setRotating(null);
      setRevealed(result.current.key ?? null);
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/projects/${project}/envs/${env}/sdk-keys/${id}`),
    onSuccess: async () => {
      toast.success('Key revoked');
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div>
      <PageHeader
        title="SDK keys"
        description="Server keys download rules; client keys only receive evaluated values. Rotation keeps the old key valid for a grace period."
        actions={
          <>
            <NativeSelect
              value={env}
              onChange={(e) =>
                void navigate({
                  to: '/projects/$project/sdk-keys',
                  params: { project },
                  search: { env: e.target.value },
                })
              }
            >
              {projectData?.environments.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.name}
                </option>
              ))}
            </NativeSelect>
            <Button variant="outline" onClick={() => create.mutate('client')}>
              <KeyRound /> Client key
            </Button>
            <Button onClick={() => create.mutate('server')}>
              <KeyRound /> Server key
            </Button>
          </>
        }
      />
      {revealed ? (
        <Alert variant="warning" className="mb-4 items-center justify-between">
          <span>
            Copy this key now, it is shown only once:{' '}
            <code className="font-mono" data-testid="revealed-key">
              {revealed}
            </code>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard?.writeText(revealed).then(() => toast.success('Copied'))}
          >
            <Copy /> Copy
          </Button>
        </Alert>
      ) : null}
      <div className="rounded-xl border bg-card">
        <Table>
          <THead>
            <TR>
              <TH>Key</TH>
              <TH>Kind</TH>
              <TH>Created</TH>
              <TH>Expires</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {list.data?.map((k) => (
              <TR key={k.id}>
                <TD className="font-mono">{k.maskedKey}</TD>
                <TD>
                  <Badge variant={k.kind === 'server' ? 'default' : 'secondary'}>{k.kind}</Badge>
                </TD>
                <TD className="text-xs">{formatDate(k.createdAt)}</TD>
                <TD className="text-xs">
                  {k.expiresAt ? (
                    <span className={k.active ? 'text-amber-600' : 'text-destructive'}>
                      {formatDate(k.expiresAt)}
                    </span>
                  ) : (
                    'never'
                  )}
                </TD>
                <TD className="text-right">
                  {k.active ? (
                    <>
                      {!k.expiresAt ? (
                        <Button size="sm" variant="ghost" onClick={() => setRotating(k)}>
                          <RotateCw /> Rotate
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => revoke.mutate(k.id)}>
                        <Trash2 /> Revoke
                      </Button>
                    </>
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      <Dialog open={rotating !== null} onOpenChange={(open) => !open && setRotating(null)}>
        <DialogContent>
          <DialogHeader
            title={`Rotate ${rotating?.maskedKey}`}
            description="A new key is issued. The old key keeps working until the grace period ends, so you can roll out the new one."
          />
          <div className="grid gap-1.5">
            <Label>Grace period (minutes)</Label>
            <Input value={grace} onChange={(e) => setGrace(e.target.value)} />
          </div>
          <DialogFooter>
            <Button onClick={() => rotating && rotate.mutate(rotating)} disabled={rotate.isPending}>
              Rotate key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
