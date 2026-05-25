import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '@/lib/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';

export function AgentsTable() {
  const q = useInfiniteQuery({
    queryKey: ['agents'],
    queryFn: ({ pageParam }) => api.agents.list({ cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (q.error) throw q.error;

  const rows = q.data?.pages.flatMap((p) => p.agents) ?? [];
  if (rows.length === 0) return <p className="text-muted-foreground">No agents yet.</p>;

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((a) => (
            <TableRow key={a.id}>
              <TableCell>
                <Link
                  to={`/agents/${a.id}` as any}
                  className="underline underline-offset-2"
                >
                  {a.name}
                </Link>
              </TableCell>
              <TableCell>{a.kind}</TableCell>
              <TableCell>{a.last_seen_at ?? '—'}</TableCell>
              <TableCell>{new Date(a.created_at).toLocaleString()}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {q.hasNextPage && (
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
        >
          {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </>
  );
}
