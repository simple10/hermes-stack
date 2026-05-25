import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { KeyRevealModal } from '@/components/shared/key-reveal-modal';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/error-messages';
import { toast } from 'sonner';

export function RegisterConnectorDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('notion');
  const [description, setDescription] = useState('');
  const [keyReveal, setKeyReveal] = useState<string | null>(null);
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: () =>
      api.connectors.create({ name, kind, description: description || undefined }),
    onSuccess: (res) => {
      setOpen(false);
      setName('');
      setDescription('');
      qc.invalidateQueries({ queryKey: ['connectors'] });
      setKeyReveal(res.key);
    },
    onError: (err) => toast.error(messageFor(err)),
  });

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button>Register connector</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register a connector</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              mut.mutate();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="conn-name">Name</Label>
              <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-kind">Kind</Label>
              <Input id="conn-kind" value={kind} onChange={(e) => setKind(e.target.value)} required />
              <p className="text-xs text-muted-foreground">e.g. notion, linear, github</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-desc">Description (optional)</Label>
              <Input id="conn-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
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
        title="Connector key"
      />
    </>
  );
}
