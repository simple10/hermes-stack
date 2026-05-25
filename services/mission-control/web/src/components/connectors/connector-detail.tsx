import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link } from '@tanstack/react-router';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
} from '@/components/ui/alert-dialog';
import { KeyRevealModal } from '@/components/shared/key-reveal-modal';
import { messageFor } from '@/lib/error-messages';
import { toast } from 'sonner';

export function ConnectorDetail({ connectorId }: { connectorId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [keyReveal, setKeyReveal] = useState<string | null>(null);
  const [name, setName] = useState<string | undefined>();
  const [description, setDescription] = useState<string | undefined>();

  const { data, isLoading } = useQuery({
    queryKey: ['connectors', connectorId],
    queryFn: () => api.connectors.get(connectorId),
  });

  const saveMut = useMutation({
    mutationFn: () =>
      api.connectors.patch(connectorId, {
        name: name || undefined,
        description: description ?? undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connectors'] });
      qc.invalidateQueries({ queryKey: ['connectors', connectorId] });
      toast.success('Connector updated');
    },
    onError: (err) => toast.error(messageFor(err)),
  });

  const rotateMut = useMutation({
    mutationFn: () => api.connectors.rotateKey(connectorId),
    onSuccess: (res) => setKeyReveal(res.key),
    onError: (err) => toast.error(messageFor(err)),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.connectors.delete(connectorId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connectors'] });
      toast.success('Connector deleted');
      navigate({ to: '/connectors' as any });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'connector.has_active_refs') {
        toast.error('Cannot delete — connector still has external refs.');
      } else {
        toast.error(messageFor(err));
      }
    },
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (!data) return <p>Not found.</p>;
  const c = data.connector;

  return (
    <div className="space-y-8 max-w-2xl">
      <header>
        <h1 className="text-2xl font-bold">{c.name}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Kind: {c.kind} • Created {new Date(c.created_at).toLocaleString()}
        </p>
        <p className="text-xs text-muted-foreground mt-1">ID: <code>{c.id}</code></p>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Edit</h2>
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" defaultValue={c.name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="desc">Description</Label>
          <Input id="desc" defaultValue={c.description ?? ''} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
          {saveMut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </section>

      <section className="space-y-4 border-t pt-6">
        <h2 className="text-lg font-semibold">Danger zone</h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => rotateMut.mutate()} disabled={rotateMut.isPending}>
            {rotateMut.isPending ? 'Rotating…' : 'Rotate key'}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">Delete connector</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this connector?</AlertDialogTitle>
                <AlertDialogDescription>
                  Soft-deletes the connector. Fails if external refs still link to it.
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
          <Link to="/connectors" className="underline">← Back to connectors</Link>
        </p>
      </section>

      <KeyRevealModal
        open={!!keyReveal}
        keyValue={keyReveal ?? ''}
        onClose={() => setKeyReveal(null)}
        title="New connector key"
      />
    </div>
  );
}
