import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { JsonDiff } from '@/components/json-diff';
import { PageHeader, useProjectKey } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { Badge, Checkbox, NativeSelect, Skeleton } from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { errorMessage, post } from '@/lib/api';
import { keys, useCompare } from '@/lib/queries';
import type { DiffEntry, Instruction } from '@/lib/types';

interface CopyPreview {
  applied: boolean;
  instructions: Instruction[];
  diff: DiffEntry[];
  changeRequest?: { id: string };
  descriptions?: string[];
}

export function ComparePage() {
  const project = useProjectKey();
  const compare = useCompare(project);
  const queryClient = useQueryClient();
  const envs = compare.data?.environments ?? [];
  const [source, setSource] = useState('staging');
  const [target, setTarget] = useState('production');
  const [includeTargets, setIncludeTargets] = useState(true);
  const [preview, setPreview] = useState<{ flag: string; data: CopyPreview } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const previewMutation = useMutation({
    mutationFn: (flag: string) =>
      post<CopyPreview>(`/projects/${project}/flags/${flag}/copy`, {
        source,
        target,
        dryRun: true,
        includeTargets,
      }),
    onSuccess: (data, flag) => setPreview({ flag, data }),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const apply = useMutation({
    mutationFn: (flag: string) =>
      post<CopyPreview>(`/projects/${project}/flags/${flag}/copy`, {
        source,
        target,
        dryRun: false,
        includeTargets,
      }),
    onSuccess: async (data, flag) => {
      toast.success(
        data.changeRequest ? `Change request created for ${flag}` : `Copied ${flag}: ${source} → ${target}`,
      );
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: keys.compare(project) });
      await queryClient.invalidateQueries({ queryKey: keys.flags(project) });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const selectedFlag = compare.data?.flags.find((f) => f.key === selected);
  return (
    <div>
      <PageHeader
        title="Compare environments"
        description="Spot drift between environments and promote a configuration with a diff preview."
        actions={
          <div className="flex items-center gap-2 text-sm">
            Copy from
            <NativeSelect
              value={source}
              onChange={(e) => setSource(e.target.value)}
              data-testid="copy-source"
            >
              {envs.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.name}
                </option>
              ))}
            </NativeSelect>
            <ArrowRight className="size-4" />
            <NativeSelect
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              data-testid="copy-target"
            >
              {envs.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.name}
                </option>
              ))}
            </NativeSelect>
            <label className="ml-2 flex items-center gap-1.5">
              <Checkbox checked={includeTargets} onCheckedChange={(v) => setIncludeTargets(v === true)} />{' '}
              include targets
            </label>
          </div>
        }
      />
      {compare.isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <THead>
              <TR>
                <TH>Flag</TH>
                {envs.map((e) => (
                  <TH key={e.key} className="text-center">
                    {e.name}
                  </TH>
                ))}
                <TH>Status</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {compare.data?.flags.map((flag) => (
                <TR
                  key={flag.key}
                  className={selected === flag.key ? 'bg-accent/40' : ''}
                  onClick={() => setSelected(flag.key)}
                >
                  <TD>
                    <Link
                      to="/projects/$project/flags/$flag"
                      params={{ project, flag: flag.key }}
                      className="font-medium hover:text-primary"
                    >
                      {flag.key}
                    </Link>
                  </TD>
                  {envs.map((e) => {
                    const cell = flag.environments[e.key];
                    return (
                      <TD key={e.key} className="text-center">
                        {cell ? (
                          <span
                            className={`inline-flex items-center gap-1 text-xs ${cell.on ? 'text-success' : 'text-muted-foreground'}`}
                          >
                            {cell.on ? 'ON' : 'OFF'}{' '}
                            <span className="text-muted-foreground">v{cell.version}</span>
                            {cell.differsFromFirst ? <Badge variant="warning">differs</Badge> : null}
                          </span>
                        ) : null}
                      </TD>
                    );
                  })}
                  <TD>
                    {flag.identical ? (
                      <Badge variant="success">in sync</Badge>
                    ) : (
                      <Badge variant="warning">drift</Badge>
                    )}
                  </TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`copy-${flag.key}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        previewMutation.mutate(flag.key);
                      }}
                    >
                      <Copy /> {source} → {target}
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
      {selectedFlag ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {envs.slice(1).map((e) => (
            <div key={e.key}>
              <div className="mb-1 text-sm font-medium">
                {envs[0]?.name} → {e.name} · {selectedFlag.key}
              </div>
              <JsonDiff entries={selectedFlag.environments[e.key]?.diff ?? []} />
            </div>
          ))}
        </div>
      ) : null}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader
            title={`Copy ${preview?.flag} from ${source} to ${target}`}
            description={`${preview?.data.instructions.length ?? 0} instruction(s) will be applied to ${target}.`}
          />
          <ol className="list-decimal pl-5 text-sm">
            {preview?.data.instructions.map((i, index) => (
              <li key={index}>{i.kind}</li>
            ))}
          </ol>
          <JsonDiff entries={preview?.data.diff ?? []} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button
              disabled={!preview || preview.data.instructions.length === 0 || apply.isPending}
              onClick={() => preview && apply.mutate(preview.flag)}
              data-testid="confirm-copy"
            >
              Apply copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
