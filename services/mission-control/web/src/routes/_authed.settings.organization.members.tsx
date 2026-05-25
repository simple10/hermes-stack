import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { messageFor } from '@/lib/error-messages'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/settings/organization/members')({
  component: MembersRoute,
})

function MembersRoute() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['org-members'],
    queryFn: () =>
      (authClient as any).organization
        .listMembers()
        .then((r: any) => r?.data?.members ?? r?.members ?? []),
  })

  const removeMut = useMutation({
    mutationFn: (memberIdOrEmail: string) =>
      (authClient as any).organization.removeMember({ memberIdOrEmail }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-members'] })
      toast.success('Member removed')
    },
    onError: (err) => toast.error(messageFor(err)),
  })

  const updateRoleMut = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: string }) =>
      (authClient as any).organization.updateMemberRole({ memberId, role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-members'] })
      toast.success('Role updated')
    },
    onError: (err) => toast.error(messageFor(err)),
  })

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold">Members</h1>
      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !data || data.length === 0 ? (
        <p className="text-muted-foreground">No members.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((m: any) => (
              <TableRow key={m.id}>
                <TableCell>{m.user?.email ?? m.email ?? m.userId}</TableCell>
                <TableCell>
                  <select
                    value={m.role}
                    onChange={(e) => updateRoleMut.mutate({ memberId: m.id, role: e.target.value })}
                    className="rounded border bg-background px-2 py-1 text-sm"
                  >
                    <option value="owner">owner</option>
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                  </select>
                </TableCell>
                <TableCell>{m.createdAt ? new Date(m.createdAt).toLocaleString() : '—'}</TableCell>
                <TableCell>
                  <Button size="sm" variant="destructive" onClick={() => removeMut.mutate(m.id)}>
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
