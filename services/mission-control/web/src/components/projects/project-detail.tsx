import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, Link } from '@tanstack/react-router'
import { api } from '@/lib/api'
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

export function ProjectDetail({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState<string | undefined>()
  const [slug, setSlug] = useState<string | undefined>()
  const [description, setDescription] = useState<string | undefined>()

  const { data, isLoading } = useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => api.projects.get(projectId),
  })

  const saveMut = useMutation({
    mutationFn: () =>
      api.projects.patch(projectId, {
        name: name || undefined,
        slug: slug || undefined,
        description: description ?? undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['projects', projectId] })
      toast.success('Project updated')
    },
    onError: (err) => toast.error(messageFor(err)),
  })

  const deleteMut = useMutation({
    mutationFn: () => api.projects.delete(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Project deleted')
      navigate({ to: '/projects' as any })
    },
    onError: (err) => toast.error(messageFor(err)),
  })

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (!data) return <p>Not found.</p>
  const p = data.project

  return (
    <div className="space-y-8 max-w-2xl">
      <header>
        <h1 className="text-2xl font-bold">{p.name}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Slug: <code>{p.slug}</code> • Created {new Date(p.created_at).toLocaleString()}
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Edit</h2>
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" defaultValue={p.name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            defaultValue={p.slug}
            onChange={(e) => setSlug(e.target.value)}
            pattern="[a-z0-9-]+"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="desc">Description</Label>
          <Input
            id="desc"
            defaultValue={p.description ?? ''}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
          {saveMut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </section>

      <section className="space-y-4 border-t pt-6">
        <h2 className="text-lg font-semibold">Danger zone</h2>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Delete project</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this project?</AlertDialogTitle>
              <AlertDialogDescription>
                Soft-deletes the project. Associated tasks are unaffected; they keep their
                project_id reference.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMut.mutate()}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <p className="text-xs text-muted-foreground">
          <Link to="/projects" className="underline">
            ← Back to projects
          </Link>
        </p>
      </section>
    </div>
  )
}
