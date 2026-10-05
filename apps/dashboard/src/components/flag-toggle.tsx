import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage, patch, post } from '@/lib/api';
import { keys } from '@/lib/queries';
import type { Environment } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from './ui/overlays';
import { Switch, Textarea } from './ui/primitives';

export function isProtected(env: Environment) {
  return env.requireApproval || env.key === 'production';
}

export function FlagToggle({
  project,
  flagKey,
  env,
  on,
  version,
  size = 'sm',
}: {
  project: string;
  flagKey: string;
  env: Environment;
  on: boolean;
  version: number;
  size?: 'sm' | 'lg';
}) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [comment, setComment] = useState('');
  const instruction = [{ kind: on ? 'turnOff' : 'turnOn' }];
  const mutation = useMutation({
    mutationFn: async () => {
      if (env.requireApproval) {
        await post(`/projects/${project}/flags/${flagKey}/envs/${env.key}/change-requests`, {
          instructions: instruction,
          comment: comment || undefined,
        });
        return 'requested';
      }
      await patch(
        `/projects/${project}/flags/${flagKey}/envs/${env.key}`,
        { instructions: instruction, comment: comment || undefined },
        { 'if-match': `"${version}"` },
      );
      return 'saved';
    },
    onSuccess: (result) => {
      toast.success(
        result === 'requested'
          ? `Approval requested to turn ${on ? 'off' : 'on'} ${flagKey} in ${env.name}`
          : `${flagKey} is now ${on ? 'off' : 'on'} in ${env.name}`,
      );
      setConfirm(false);
      setComment('');
      void queryClient.invalidateQueries({ queryKey: keys.flags(project) });
      void queryClient.invalidateQueries({ queryKey: keys.flag(project, flagKey) });
      void queryClient.invalidateQueries({ queryKey: keys.changeRequests(project) });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409)
        toast.error('Someone changed this flag meanwhile. Reloaded the latest version.');
      else toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: keys.flags(project) });
      void queryClient.invalidateQueries({ queryKey: keys.flag(project, flagKey) });
    },
  });
  const onToggle = () => {
    if (isProtected(env)) setConfirm(true);
    else mutation.mutate();
  };
  return (
    <>
      {size === 'lg' ? (
        <button
          data-testid={`kill-switch-${env.key}`}
          onClick={onToggle}
          disabled={mutation.isPending}
          className={`flex items-center gap-3 rounded-xl border-2 px-4 py-2.5 text-left transition-colors ${on ? 'border-success/50 bg-success/10' : 'border-border bg-muted/40'}`}
        >
          <span
            className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${on ? 'bg-success' : 'bg-input'}`}
            aria-hidden
          >
            <span
              className={`block size-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`}
            />
          </span>
          <div>
            <div className="text-sm font-semibold">{on ? 'Targeting is ON' : 'Targeting is OFF'}</div>
            <div className="text-xs text-muted-foreground">
              {on ? 'Rules are evaluated' : 'Everyone gets the off variation'}
            </div>
          </div>
        </button>
      ) : (
        <Switch
          checked={on}
          onCheckedChange={onToggle}
          disabled={mutation.isPending}
          data-testid={`toggle-${flagKey}-${env.key}`}
          aria-label={`${flagKey} in ${env.name}`}
        />
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader
            title={`${env.requireApproval ? 'Request approval to turn' : 'Turn'} ${on ? 'off' : 'on'} ${flagKey} in ${env.name}?`}
            description={
              env.requireApproval
                ? 'This environment requires an approved change request. A reviewer has to approve before the change is applied.'
                : 'This is a production environment. The change reaches every SDK within a second.'
            }
          />
          <Textarea
            placeholder="Comment (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant={on ? 'destructive' : 'default'}
              data-testid="confirm-toggle"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {env.requireApproval ? 'Request approval' : on ? 'Turn off' : 'Turn on'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
