import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { messageFor } from '@/lib/error-messages'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/settings/organization/invitations')({
  component: InvitationsRoute,
})

function InvitationsRoute() {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('member')

  const { data, isLoading } = useQuery({
    queryKey: ['org-invitations'],
    queryFn: () =>
      (authClient as any).organization.listInvitations().then((r: any) => r?.data ?? r ?? []),
  })

  const inviteMut = useMutation({
    mutationFn: () => (authClient as any).organization.inviteMember({ email, role }),
    onSuccess: () => {
      setEmail('')
      qc.invalidateQueries({ queryKey: ['org-invitations'] })
      toast.success('Invitation sent')
    },
    onError: (err) => toast.error(messageFor(err)),
  })

  const cancelMut = useMutation({
    mutationFn: (invitationId: string) =>
      (authClient as any).organization.cancelInvitation({ invitationId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-invitations'] })
      toast.success('Invitation cancelled')
    },
    onError: (err) => toast.error(messageFor(err)),
  })

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold">Invitations</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          inviteMut.mutate()
        }}
        className="flex gap-2 items-end border rounded p-4"
      >
        <div className="flex-1 space-y-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invite-role">Role</Label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="block rounded border bg-background px-3 py-2 text-sm"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
            <option value="owner">owner</option>
          </select>
        </div>
        <Button type="submit" disabled={inviteMut.isPending}>
          {inviteMut.isPending ? 'Sending…' : 'Send invite'}
        </Button>
      </form>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !data || data.length === 0 ? (
        <p className="text-muted-foreground">No pending invitations.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((inv: any) => (
              <TableRow key={inv.id}>
                <TableCell>{inv.email}</TableCell>
                <TableCell>{inv.role}</TableCell>
                <TableCell>{inv.status}</TableCell>
                <TableCell>
                  {inv.expiresAt ? new Date(inv.expiresAt).toLocaleString() : '—'}
                </TableCell>
                <TableCell>
                  {inv.status === 'pending' && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => cancelMut.mutate(inv.id)}
                    >
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
