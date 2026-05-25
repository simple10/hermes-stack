import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { authClient, useSession } from '@/lib/auth-client'
import { queryClient } from '@/lib/query-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { messageFor } from '@/lib/error-messages'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/settings/organization')({
  component: OrgSettingsRoute,
})

function OrgSettingsRoute() {
  const navigate = useNavigate()
  const { data: session } = useSession() as any
  const orgId: string | undefined = session?.session?.activeOrganizationId
  const [name, setName] = useState<string | undefined>()
  const [slug, setSlug] = useState<string | undefined>()

  const updateMut = useMutation({
    mutationFn: () =>
      (authClient as any).organization.update({
        organizationId: orgId,
        data: { name: name || undefined, slug: slug || undefined },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries()
      toast.success('Organization updated')
    },
    onError: (err) => toast.error(messageFor(err)),
  })

  const deleteMut = useMutation({
    mutationFn: () => (authClient as any).organization.delete({ organizationId: orgId }),
    onSuccess: () => {
      queryClient.clear()
      toast.success('Organization deleted')
      navigate({ to: '/' as any })
    },
    onError: (err) => toast.error(messageFor(err)),
  })

  if (!orgId) return <p className="text-muted-foreground">No active organization.</p>

  return (
    <div className="space-y-8 max-w-2xl">
      <header>
        <h1 className="text-2xl font-bold">Organization settings</h1>
        <p className="text-xs text-muted-foreground mt-1">
          ID: <code>{orgId}</code>
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Rename</h2>
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" onChange={(e) => setName(e.target.value)} placeholder="New name" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            onChange={(e) => setSlug(e.target.value)}
            pattern="[a-z0-9-]+"
            placeholder="new-slug"
          />
        </div>
        <Button onClick={() => updateMut.mutate()} disabled={updateMut.isPending}>
          {updateMut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </section>

      <section className="space-y-4 border-t pt-6">
        <h2 className="text-lg font-semibold">Danger zone</h2>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Delete organization</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this organization?</AlertDialogTitle>
              <AlertDialogDescription>
                This is irreversible. All agents, connectors, projects, and tasks under this org
                will be removed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMut.mutate()}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  )
}
