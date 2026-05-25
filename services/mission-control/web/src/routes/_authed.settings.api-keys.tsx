import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authClient } from '@/lib/auth-client';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { KeyRevealModal } from '@/components/shared/key-reveal-modal';
import { messageFor } from '@/lib/error-messages';
import { toast } from 'sonner';

export const Route = createFileRoute('/_authed/settings/api-keys')({
  component: ApiKeysRoute,
});

function ApiKeysRoute() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () =>
      (authClient as any).apiKey.list().then((r: any) => r?.data ?? r ?? []),
  });
  const [name, setName] = useState('');
  const [expiresIn, setExpiresIn] = useState('2592000'); // 30 days in seconds
  const [creating, setCreating] = useState(false);
  const [keyReveal, setKeyReveal] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () =>
      (authClient as any).apiKey.create({
        name,
        prefix: 'mcpat_',
        expiresIn: parseInt(expiresIn, 10) || undefined,
      }),
    onSuccess: (res: any) => {
      setName('');
      setCreating(false);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
      const key = res?.data?.key ?? res?.key;
      if (key) setKeyReveal(key);
    },
    onError: (err) => toast.error(messageFor(err)),
  });

  const revokeMut = useMutation({
    mutationFn: (keyId: string) => (authClient as any).apiKey.delete({ keyId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success('Key revoked');
    },
    onError: (err) => toast.error(messageFor(err)),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">API Keys (PATs)</h1>
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogTrigger asChild><Button>Create PAT</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Create a new PAT</DialogTitle></DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); createMut.mutate(); }} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="key-name">Name</Label>
                <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="key-expires">Expires in</Label>
                <select
                  id="key-expires" value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)}
                  className="block w-full rounded border bg-background px-3 py-2 text-sm"
                >
                  <option value="604800">7 days</option>
                  <option value="2592000">30 days</option>
                  <option value="7776000">90 days</option>
                  <option value="0">Never</option>
                </select>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createMut.isPending}>
                  {createMut.isPending ? 'Creating…' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {isLoading ? <p className="text-muted-foreground">Loading…</p>
        : !data || data.length === 0 ? <p className="text-muted-foreground">No API keys yet.</p>
        : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Prefix</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {data.map((k: any) => (
                <TableRow key={k.id}>
                  <TableCell>{k.name}</TableCell>
                  <TableCell className="font-mono text-xs">{k.start ?? k.prefix}…</TableCell>
                  <TableCell>{k.createdAt ? new Date(k.createdAt).toLocaleString() : '—'}</TableCell>
                  <TableCell>{k.lastRequest ? new Date(k.lastRequest).toLocaleString() : '—'}</TableCell>
                  <TableCell>{k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'Never'}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="destructive" onClick={() => revokeMut.mutate(k.id)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      <KeyRevealModal
        open={!!keyReveal} keyValue={keyReveal ?? ''}
        onClose={() => setKeyReveal(null)} title="Personal access token"
      />
    </div>
  );
}
