import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader, useProjectKey } from '@/components/layout';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Switch,
} from '@/components/ui/primitives';
import { errorMessage, patch, post } from '@/lib/api';
import { keys, useProject } from '@/lib/queries';

export function SettingsPage() {
  const project = useProjectKey();
  const { data } = useProject(project);
  const queryClient = useQueryClient();
  const [newEnv, setNewEnv] = useState({ key: '', name: '' });
  const update = useMutation({
    mutationFn: ({ env, body }: { env: string; body: Record<string, unknown> }) =>
      patch(`/projects/${project}/environments/${env}`, body),
    onSuccess: async () => {
      toast.success('Environment updated');
      await queryClient.invalidateQueries({ queryKey: keys.projects });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const create = useMutation({
    mutationFn: () => post(`/projects/${project}/environments`, newEnv),
    onSuccess: async () => {
      toast.success('Environment created');
      setNewEnv({ key: '', name: '' });
      await queryClient.invalidateQueries({ queryKey: keys.projects });
      await queryClient.invalidateQueries({ queryKey: keys.flags(project) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div className="grid max-w-3xl gap-5">
      <PageHeader
        title="Project settings"
        description={`${data?.name ?? project} · ${data?.organization.name ?? ''}`}
      />
      <Card>
        <CardHeader>
          <CardTitle>Environments</CardTitle>
          <CardDescription>
            Require approval turns direct edits into change requests that need a second person.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {data?.environments.map((env) => (
            <div key={env.key} className="flex items-center gap-3 rounded-lg border p-3">
              <input
                type="color"
                value={env.color}
                onChange={(e) => update.mutate({ env: env.key, body: { color: e.target.value } })}
                className="size-7 rounded border"
              />
              <div className="flex-1">
                <div className="font-medium">{env.name}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {env.key} · ruleset v{env.version}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                Require approval
                <Switch
                  checked={env.requireApproval}
                  data-testid={`require-approval-${env.key}`}
                  onCheckedChange={(v) => update.mutate({ env: env.key, body: { requireApproval: v } })}
                />
              </label>
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              placeholder="key (e.g. qa)"
              value={newEnv.key}
              onChange={(e) => setNewEnv({ ...newEnv, key: e.target.value })}
            />
            <Input
              placeholder="Name"
              value={newEnv.name}
              onChange={(e) => setNewEnv({ ...newEnv, name: e.target.value })}
            />
            <Button onClick={() => create.mutate()} disabled={!newEnv.key || !newEnv.name}>
              <Plus /> Add
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
