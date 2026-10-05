import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { del, errorMessage, patch } from '@/lib/api';
import { keys, useFlags } from '@/lib/queries';
import type { FlagDetail } from '@/lib/types';
import { displayValue } from '@/lib/utils';
import { Button } from './ui/button';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  NativeSelect,
  Textarea,
} from './ui/primitives';

export function FlagSettings({ project, flag }: { project: string; flag: FlagDetail }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const allFlags = useFlags(project);
  const [name, setName] = useState(flag.name);
  const [description, setDescription] = useState(flag.description ?? '');
  const [tags, setTags] = useState(flag.tags.join(', '));
  const [temporary, setTemporary] = useState(flag.temporary);
  const [clientSide, setClientSide] = useState(flag.clientSideAvailable);
  const [prerequisites, setPrerequisites] = useState(flag.prerequisites);
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.flag(project, flag.key) });
    await queryClient.invalidateQueries({ queryKey: keys.flags(project) });
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/projects/${project}/flags/${flag.key}`, body),
    onSuccess: async () => {
      toast.success('Flag updated');
      await invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: () => del(`/projects/${project}/flags/${flag.key}`),
    onSuccess: async () => {
      toast.success('Flag deleted');
      await queryClient.invalidateQueries({ queryKey: keys.flags(project) });
      await navigate({ to: '/projects/$project/flags', params: { project } });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const candidates = (allFlags.data ?? []).filter((f) => f.key !== flag.key && !f.archivedAt);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Definition</CardTitle>
          <CardDescription>Shared by all environments.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Tags</Label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={temporary} onCheckedChange={(v) => setTemporary(v === true)} /> Temporary flag
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={clientSide} onCheckedChange={(v) => setClientSide(v === true)} /> Available to
            client-side SDKs (values only, never rules)
          </label>
          <div className="grid gap-2">
            <Label>Prerequisites</Label>
            {prerequisites.map((p, i) => {
              const target = candidates.find((f) => f.key === p.flagKey);
              return (
                <div key={i} className="flex gap-2">
                  <NativeSelect
                    className="flex-1"
                    value={p.flagKey}
                    onChange={(e) =>
                      setPrerequisites(
                        prerequisites.map((x, j) =>
                          j === i
                            ? {
                                flagKey: e.target.value,
                                variationId:
                                  candidates.find((f) => f.key === e.target.value)?.variations[0]?.id ?? '',
                              }
                            : x,
                        ),
                      )
                    }
                  >
                    {candidates.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.key}
                      </option>
                    ))}
                  </NativeSelect>
                  <NativeSelect
                    value={p.variationId}
                    onChange={(e) =>
                      setPrerequisites(
                        prerequisites.map((x, j) => (j === i ? { ...x, variationId: e.target.value } : x)),
                      )
                    }
                  >
                    {target?.variations.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name ?? displayValue(v.value)}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setPrerequisites(prerequisites.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              disabled={candidates.length === 0}
              onClick={() =>
                setPrerequisites([
                  ...prerequisites,
                  { flagKey: candidates[0]!.key, variationId: candidates[0]!.variations[0]!.id },
                ])
              }
            >
              <Plus /> Add prerequisite
            </Button>
          </div>
          <Button
            className="w-fit"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                name,
                description,
                tags: tags
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
                temporary,
                clientSideAvailable: clientSide,
                prerequisites,
              })
            }
          >
            Save definition
          </Button>
        </CardContent>
      </Card>
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Variations</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {flag.variations.map((v) => (
              <div key={v.id} className="flex items-center gap-2 text-sm">
                <Badge variant="outline">{v.id}</Badge>
                <span className="font-medium">{v.name}</span>
                <code className="ml-auto truncate font-mono text-xs text-muted-foreground">
                  {displayValue(v.value)}
                </code>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Salt {flag.salt} · created {new Date(flag.createdAt).toLocaleDateString()}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Lifecycle</CardTitle>
            <CardDescription>
              Archived flags disappear from SDK rulesets. Delete is only possible after archiving.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            {flag.archivedAt ? (
              <>
                <Button variant="outline" onClick={() => save.mutate({ archived: false })}>
                  <ArchiveRestore /> Restore
                </Button>
                <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
                  <Trash2 /> Delete permanently
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                onClick={() => save.mutate({ archived: true })}
                data-testid="archive-flag"
              >
                <Archive /> Archive flag
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
