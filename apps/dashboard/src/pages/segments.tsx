import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ClauseBuilder } from '@/components/clause-builder';
import { PageHeader, useProjectKey } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  NativeSelect,
  Textarea,
} from '@/components/ui/primitives';
import { del, errorMessage, patch, post } from '@/lib/api';
import { keys, useAttributes, useProject, useSegments } from '@/lib/queries';
import type { Segment } from '@/lib/types';

type Draft = Pick<
  Segment,
  'key' | 'name' | 'description' | 'contextKind' | 'included' | 'excluded' | 'rules'
> & { version?: number; isNew: boolean };

const split = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);

export function SegmentsPage() {
  const project = useProjectKey();
  const search = useSearch({ from: '/projects/$project/segments' });
  const navigate = useNavigate();
  const { data: projectData } = useProject(project);
  const env = search.env ?? 'production';
  const segments = useSegments(project, env);
  const attributes = useAttributes(project, env);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const body = {
        name: d.name,
        description: d.description ?? undefined,
        contextKind: d.contextKind,
        included: d.included,
        excluded: d.excluded,
        rules: d.rules,
      };
      if (d.isNew) return post(`/projects/${project}/envs/${env}/segments`, { key: d.key, ...body });
      return patch(`/projects/${project}/envs/${env}/segments/${d.key}`, body, {
        'if-match': `"${d.version}"`,
      });
    },
    onSuccess: async () => {
      toast.success('Segment saved');
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: keys.segments(project, env) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (key: string) => del(`/projects/${project}/envs/${env}/segments/${key}`),
    onSuccess: async () => {
      toast.success('Segment deleted');
      await queryClient.invalidateQueries({ queryKey: keys.segments(project, env) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div>
      <PageHeader
        title="Segments"
        description="Reusable groups of contexts, configured per environment."
        actions={
          <>
            <NativeSelect
              value={env}
              onChange={(e) =>
                void navigate({
                  to: '/projects/$project/segments',
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
            <Button
              data-testid="new-segment"
              onClick={() =>
                setDraft({
                  key: '',
                  name: '',
                  description: '',
                  contextKind: 'user',
                  included: [],
                  excluded: [],
                  rules: [],
                  isNew: true,
                })
              }
            >
              <Plus /> New segment
            </Button>
          </>
        }
      />
      {segments.data?.length === 0 ? <EmptyState title="No segments yet" /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {segments.data?.map((s) => (
          <Card key={s.key} data-testid={`segment-${s.key}`}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {s.name} <Badge variant="outline">{s.contextKind}</Badge>
              </CardTitle>
              <CardDescription className="font-mono">{s.key}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {s.description ? <p className="text-muted-foreground">{s.description}</p> : null}
              <div>
                {s.included.length} included · {s.excluded.length} excluded · {s.rules.length} rule(s) · v
                {s.version}
              </div>
              <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                Used by: {s.usedBy?.length ? s.usedBy.map((f) => <Badge key={f}>{f}</Badge>) : 'no flags'}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setDraft({ ...s, isNew: false })}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => remove.mutate(s.key)}
                  disabled={!!s.usedBy?.length}
                >
                  <Trash2 /> Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader
            title={draft?.isNew ? 'New segment' : `Edit ${draft?.key}`}
            description={`Environment ${env}`}
          />
          {draft ? (
            <div className="grid gap-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-1.5">
                  <Label>Name</Label>
                  <Input
                    value={draft.name}
                    data-testid="segment-name"
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        name: e.target.value,
                        key: draft.isNew
                          ? e.target.value
                              .toLowerCase()
                              .replace(/[^a-z0-9]+/g, '-')
                              .replace(/^-|-$/g, '')
                          : draft.key,
                      })
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Key</Label>
                  <Input
                    value={draft.key}
                    disabled={!draft.isNew}
                    className="font-mono"
                    onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Context kind</Label>
                  <NativeSelect
                    value={draft.contextKind}
                    onChange={(e) => setDraft({ ...draft, contextKind: e.target.value })}
                  >
                    <option>user</option>
                    <option>organization</option>
                    <option>device</option>
                  </NativeSelect>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>Description</Label>
                <Input
                  value={draft.description ?? ''}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Included keys</Label>
                  <Textarea
                    className="font-mono text-xs"
                    defaultValue={draft.included.join(', ')}
                    onBlur={(e) => setDraft({ ...draft, included: split(e.target.value) })}
                    data-testid="segment-included"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Excluded keys</Label>
                  <Textarea
                    className="font-mono text-xs"
                    defaultValue={draft.excluded.join(', ')}
                    onBlur={(e) => setDraft({ ...draft, excluded: split(e.target.value) })}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label>Rules (any rule matches, all conditions within a rule)</Label>
                {draft.rules.map((rule, ri) => (
                  <Card key={ri} className="grid gap-2 p-3">
                    {rule.clauses.map((clause, ci) => (
                      <ClauseBuilder
                        key={ci}
                        clause={clause}
                        attributes={(attributes.data ?? []).map((a) => a.name)}
                        segments={(segments.data ?? []).map((s) => s.key).filter((k) => k !== draft.key)}
                        onChange={(next) =>
                          setDraft({
                            ...draft,
                            rules: draft.rules.map((r, i) =>
                              i === ri
                                ? { ...r, clauses: r.clauses.map((c, j) => (j === ci ? next : c)) }
                                : r,
                            ),
                          })
                        }
                        onRemove={() =>
                          setDraft({
                            ...draft,
                            rules: draft.rules
                              .map((r, i) =>
                                i === ri ? { ...r, clauses: r.clauses.filter((_, j) => j !== ci) } : r,
                              )
                              .filter((r) => r.clauses.length > 0),
                          })
                        }
                      />
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-fit"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          rules: draft.rules.map((r, i) =>
                            i === ri
                              ? { ...r, clauses: [...r.clauses, { attribute: '', op: 'in', values: [] }] }
                              : r,
                          ),
                        })
                      }
                    >
                      <Plus /> AND condition
                    </Button>
                  </Card>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      rules: [
                        ...draft.rules,
                        { clauses: [{ attribute: 'email', op: 'ends_with', values: [] }] },
                      ],
                    })
                  }
                >
                  <Plus /> Add rule
                </Button>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => draft && save.mutate(draft)}
              disabled={save.isPending}
              data-testid="save-segment"
            >
              Save segment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
