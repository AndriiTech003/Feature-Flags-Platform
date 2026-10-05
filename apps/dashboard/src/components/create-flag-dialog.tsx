import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { errorMessage, post } from '@/lib/api';
import { keys } from '@/lib/queries';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTrigger } from './ui/overlays';
import { Checkbox, Input, Label, NativeSelect, Textarea } from './ui/primitives';

const schema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-_.]{0,63}$/, 'lowercase letters, digits, - _ .'),
  name: z.string().min(1, 'required'),
  description: z.string().optional(),
  kind: z.enum(['boolean', 'string', 'number', 'json']),
  tags: z.string().optional(),
  temporary: z.boolean(),
  clientSideAvailable: z.boolean(),
  variations: z.array(z.object({ id: z.string().min(1), name: z.string().optional(), value: z.string() })),
});

type FormValues = z.infer<typeof schema>;

function parseValue(kind: FormValues['kind'], raw: string): unknown {
  if (kind === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a number`);
    return n;
  }
  if (kind === 'json') return JSON.parse(raw);
  return raw;
}

export function CreateFlagDialog({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      key: '',
      name: '',
      description: '',
      kind: 'boolean',
      tags: '',
      temporary: true,
      clientSideAvailable: true,
      variations: [
        { id: 'a', value: '' },
        { id: 'b', value: '' },
      ],
    },
  });
  const variations = useFieldArray({ control: form.control, name: 'variations' });
  const kind = form.watch('kind');
  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const body: Record<string, unknown> = {
        key: values.key,
        name: values.name,
        description: values.description || undefined,
        kind: values.kind,
        tags: values.tags
          ? values.tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        temporary: values.temporary,
        clientSideAvailable: values.clientSideAvailable,
      };
      if (values.kind !== 'boolean')
        body.variations = values.variations.map((v) => ({
          id: v.id,
          name: v.name || undefined,
          value: parseValue(values.kind, v.value),
        }));
      return post<{ key: string }>(`/projects/${project}/flags`, body);
    },
    onSuccess: (flag) => {
      toast.success(`Created ${flag.key}`);
      setOpen(false);
      form.reset();
      void queryClient.invalidateQueries({ queryKey: keys.flags(project) });
      void navigate({ to: '/projects/$project/flags/$flag', params: { project, flag: flag.key } });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="new-flag">
          <Plus /> New flag
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader
          title="Create a flag"
          description="The definition is shared by all environments; targeting is configured per environment."
        />
        <form className="grid gap-4" onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Name</Label>
              <Input
                data-testid="flag-name"
                {...form.register('name', {
                  onChange: (e) => {
                    if (!form.formState.dirtyFields.key)
                      form.setValue(
                        'key',
                        String(e.target.value)
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, '-')
                          .replace(/^-|-$/g, ''),
                      );
                  },
                })}
              />
              {form.formState.errors.name ? (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label>Key</Label>
              <Input data-testid="flag-key" className="font-mono" {...form.register('key')} />
              {form.formState.errors.key ? (
                <p className="text-xs text-destructive">{form.formState.errors.key.message}</p>
              ) : null}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Description</Label>
            <Textarea rows={2} {...form.register('description')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Kind</Label>
              <NativeSelect data-testid="flag-kind" {...form.register('kind')}>
                <option value="boolean">Boolean</option>
                <option value="string">String</option>
                <option value="number">Number</option>
                <option value="json">JSON</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label>Tags</Label>
              <Input placeholder="checkout, release" {...form.register('tags')} />
            </div>
          </div>
          {kind !== 'boolean' ? (
            <div className="grid gap-2">
              <Label>Variations</Label>
              {variations.fields.map((field, index) => (
                <div key={field.id} className="flex gap-2">
                  <Input
                    className="w-24 font-mono"
                    placeholder="id"
                    {...form.register(`variations.${index}.id`)}
                  />
                  <Input className="w-32" placeholder="name" {...form.register(`variations.${index}.name`)} />
                  <Input
                    className="flex-1 font-mono"
                    placeholder={kind === 'json' ? '{"layout":"grid"}' : 'value'}
                    {...form.register(`variations.${index}.value`)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => variations.remove(index)}
                    disabled={variations.fields.length <= 2}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() =>
                  variations.append({ id: String.fromCharCode(97 + variations.fields.length), value: '' })
                }
              >
                <Plus /> Add variation
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.watch('temporary')}
                onCheckedChange={(v) => form.setValue('temporary', v === true)}
              />{' '}
              Temporary (remind to remove)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                data-testid="flag-client-side"
                checked={form.watch('clientSideAvailable')}
                onCheckedChange={(v) => form.setValue('clientSideAvailable', v === true)}
              />{' '}
              Available to client-side SDKs
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" data-testid="create-flag-submit" disabled={mutation.isPending}>
              Create flag
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
