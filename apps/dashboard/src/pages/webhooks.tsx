import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader, useProjectKey } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { Badge, Card, CardContent, EmptyState, Input, Label, Switch } from '@/components/ui/primitives';
import { del, errorMessage, get, patch, post } from '@/lib/api';
import { keys, useWebhooks } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

function Deliveries({ id }: { id: string }) {
  const deliveries = useQuery({
    queryKey: ['deliveries', id],
    queryFn: async () =>
      (
        await get<{
          items: Array<{
            id: number;
            event: string;
            statusCode: number | null;
            ok: boolean;
            createdAt: string;
            error: string | null;
          }>;
        }>(`/webhooks/${id}/deliveries`)
      ).items,
  });
  return (
    <div className="mt-2 grid gap-1 text-xs">
      {deliveries.data?.slice(0, 5).map((d) => (
        <div key={d.id} className="flex gap-2">
          <Badge variant={d.ok ? 'success' : 'destructive'}>{d.statusCode ?? 'error'}</Badge>
          <span>{d.event}</span>
          <span className="text-muted-foreground">{relativeTime(d.createdAt)}</span>
          {d.error ? <span className="truncate text-destructive">{d.error}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function WebhooksPage() {
  const project = useProjectKey();
  const hooks = useWebhooks();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    url: '',
    secret: '',
    events: 'flag.config.updated, change_request.created',
    scoped: true,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.webhooks });
  const create = useMutation({
    mutationFn: () =>
      post('/webhooks', {
        url: form.url,
        secret: form.secret || undefined,
        events: form.events
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean),
        projectKey: form.scoped ? project : undefined,
      }),
    onSuccess: async () => {
      setOpen(false);
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const test = useMutation({
    mutationFn: (id: string) => post<{ ok: boolean }>(`/webhooks/${id}/test`),
    onSuccess: async (result, id) => {
      if (result.ok) toast.success('Test delivered');
      else toast.error('Test delivery failed');
      await queryClient.invalidateQueries({ queryKey: ['deliveries', id] });
    },
  });
  return (
    <div>
      <PageHeader
        title="Webhooks"
        description="Slack-compatible notifications on flag changes, signed with HMAC-SHA256 (X-FFP-Signature)."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus /> Webhook
          </Button>
        }
      />
      {hooks.data?.length === 0 ? (
        <EmptyState
          title="No webhooks"
          description="Point one at a Slack incoming webhook URL to get notified about flag changes."
        />
      ) : null}
      <div className="grid gap-3">
        {hooks.data?.map((hook) => (
          <Card key={hook.id}>
            <CardContent className="pt-5">
              <div className="flex flex-wrap items-center gap-3">
                <code className="flex-1 truncate font-mono text-sm">{hook.url}</code>
                {hook.projectKey ? (
                  <Badge variant="outline">{hook.projectKey}</Badge>
                ) : (
                  <Badge variant="secondary">all projects</Badge>
                )}
                {hook.hasSecret ? <Badge>signed</Badge> : null}
                <Switch
                  checked={hook.enabled}
                  onCheckedChange={(v) => void patch(`/webhooks/${hook.id}`, { enabled: v }).then(refresh)}
                />
                <Button size="sm" variant="outline" onClick={() => test.mutate(hook.id)}>
                  <Send /> Test
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void del(`/webhooks/${hook.id}`).then(refresh)}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Events: {hook.events.join(', ')}</div>
              <Deliveries id={hook.id} />
            </CardContent>
          </Card>
        ))}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader title="New webhook" />
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>URL</Label>
              <Input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://hooks.slack.com/services/…"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Signing secret (optional)</Label>
              <Input value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>Events</Label>
              <Input value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.scoped} onCheckedChange={(v) => setForm({ ...form, scoped: v })} /> Only
              this project
            </label>
          </div>
          <DialogFooter>
            <Button onClick={() => create.mutate()} disabled={!form.url || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
