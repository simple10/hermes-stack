import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { KeyRevealModal } from '@/components/shared/key-reveal-modal'
import { api } from '@/lib/api'
import { messageFor } from '@/lib/error-messages'
import { toast } from 'sonner'

export function RegisterAgentDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('hermes')
  const [description, setDescription] = useState('')
  const [keyReveal, setKeyReveal] = useState<string | null>(null)
  const qc = useQueryClient()

  const mut = useMutation({
    mutationFn: () => api.agents.create({ name, kind, description: description || undefined }),
    onSuccess: (res) => {
      setOpen(false)
      setName('')
      setDescription('')
      qc.invalidateQueries({ queryKey: ['agents'] })
      setKeyReveal(res.key)
    },
    onError: (err) => toast.error(messageFor(err)),
  })

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button>Register agent</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register an agent</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              mut.mutate()
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-kind">Kind</Label>
              <Input
                id="agent-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">e.g. hermes, claude, openclaw</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-desc">Description (optional)</Label>
              <Input
                id="agent-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={mut.isPending}>
                {mut.isPending ? 'Creating…' : 'Create + mint key'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <KeyRevealModal
        open={!!keyReveal}
        keyValue={keyReveal ?? ''}
        onClose={() => setKeyReveal(null)}
        title="Agent key"
      />
    </>
  )
}
