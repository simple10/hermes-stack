import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, Link } from '@tanstack/react-router'
import { api, ApiError } from '@/lib/api'
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
import { KeyRevealModal } from '@/components/shared/key-reveal-modal'
import { messageFor } from '@/lib/error-messages'
import { toast } from 'sonner'

export function AgentDetail({ agentId }: { agentId: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [keyReveal, setKeyReveal] = useState<string | null>(null)
  const [name, setName] = useState<string | undefined>()
  const [description, setDescription] = useState<string | undefined>()

  const { data, isLoading } = useQuery({
    queryKey: ['agents', agentId],
    queryFn: () => api.agents.get(agentId),
  })

  const saveMut = useMutation({
    mutationFn: () =>
      api.agents.patch(agentId, {
        name: name || undefined,
        description: description ?? undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      qc.invalidateQueries({ queryKey: ['agents', agentId] })
      toast.success('Agent updated')
    },
    onError: (err) => toast.error(messageFor(err)),
  })

  const rotateMut = useMutation({
    mutationFn: () => api.agents.rotateKey(agentId),
    onSuccess: (res) => setKeyReveal(res.key),
    onError: (err) => toast.error(messageFor(err)),
  })

  const deleteMut = useMutation({
    mutationFn: () => api.agents.delete(agentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      toast.success('Agent deleted')
      navigate({ to: '/agents' as any })
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'agent.has_active_tasks') {
        const ids = (err.details as any)?.task_ids as string[] | undefined
        toast.error(
          `Cannot delete — agent has active tasks${ids?.length ? `: ${ids.join(', ')}` : ''}.`,
        )
      } else {
        toast.error(messageFor(err))
      }
    },
  })

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (!data) return <p>Not found.</p>
  const agent = data.agent

  return (
    <div className="space-y-8 max-w-2xl">
      <header>
        <h1 className="text-2xl font-bold">{agent.name}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Kind: {agent.kind} • Created {new Date(agent.created_at).toLocaleString()}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          ID: <code>{agent.id}</code>
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Edit</h2>
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" defaultValue={agent.name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="desc">Description</Label>
          <Input
            id="desc"
            defaultValue={agent.description ?? ''}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
          {saveMut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </section>

      <section className="space-y-4 border-t pt-6">
        <h2 className="text-lg font-semibold">Danger zone</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => rotateMut.mutate()}
            disabled={rotateMut.isPending}
          >
            {rotateMut.isPending ? 'Rotating…' : 'Rotate key'}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">Delete agent</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this agent?</AlertDialogTitle>
                <AlertDialogDescription>
                  Soft-deletes the agent. Fails if active tasks are still assigned.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteMut.mutate()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <p className="text-xs text-muted-foreground">
          <Link to="/agents" className="underline">
            ← Back to agents
          </Link>
        </p>
      </section>

      <KeyRevealModal
        open={!!keyReveal}
        keyValue={keyReveal ?? ''}
        onClose={() => setKeyReveal(null)}
        title="New agent key (old key remains valid briefly during grace window)"
      />
    </div>
  )
}
