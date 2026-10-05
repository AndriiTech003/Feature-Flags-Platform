import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader, useProjectKey } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Alert, Input, NativeSelect } from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { del, errorMessage, patch, post } from '@/lib/api';
import { keys, useMe, useMembers, useProject } from '@/lib/queries';
import { formatDate } from '@/lib/utils';

export function MembersPage() {
  const project = useProjectKey();
  const { data: projectData } = useProject(project);
  const org = projectData?.organization.id ?? '';
  const members = useMembers(org);
  const me = useMe();
  const queryClient = useQueryClient();
  const [invite, setInvite] = useState({ email: '', role: 'writer' });
  const [password, setPassword] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.members(org) });
  const add = useMutation({
    mutationFn: () => post<{ temporaryPassword: string | null }>(`/orgs/${org}/members`, invite),
    onSuccess: async (result) => {
      setPassword(result.temporaryPassword);
      setInvite({ email: '', role: 'writer' });
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div>
      <PageHeader
        title="Members"
        description={`${projectData?.organization.name ?? ''}: admins manage keys and environments, writers change flags, readers can only look.`}
      />
      <div className="mb-4 flex gap-2">
        <Input
          className="w-72"
          placeholder="email@company.com"
          value={invite.email}
          onChange={(e) => setInvite({ ...invite, email: e.target.value })}
        />
        <NativeSelect value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
          <option value="admin">admin</option>
          <option value="writer">writer</option>
          <option value="reader">reader</option>
        </NativeSelect>
        <Button onClick={() => add.mutate()} disabled={!invite.email || add.isPending}>
          <UserPlus /> Add member
        </Button>
      </div>
      {password ? (
        <Alert variant="warning" className="mb-4">
          New account created. Temporary password (shown once): <code className="font-mono">{password}</code>
        </Alert>
      ) : null}
      <div className="rounded-xl border bg-card">
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Email</TH>
              <TH>Role</TH>
              <TH>Joined</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {members.data?.map((m) => (
              <TR key={m.id}>
                <TD className="font-medium">{m.name}</TD>
                <TD>{m.email}</TD>
                <TD>
                  <NativeSelect
                    value={m.role}
                    disabled={m.id === me.data?.id}
                    onChange={(e) =>
                      void patch(`/orgs/${org}/members/${m.id}`, { role: e.target.value })
                        .then(refresh)
                        .catch((err: unknown) => toast.error(errorMessage(err)))
                    }
                  >
                    <option value="admin">admin</option>
                    <option value="writer">writer</option>
                    <option value="reader">reader</option>
                  </NativeSelect>
                </TD>
                <TD className="text-xs">{formatDate(m.joinedAt)}</TD>
                <TD className="text-right">
                  {m.id !== me.data?.id ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void del(`/orgs/${org}/members/${m.id}`).then(refresh)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </div>
  );
}
