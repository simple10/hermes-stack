import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api } from '@/lib/api'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'

export function ProjectsTable() {
  const q = useInfiniteQuery({
    queryKey: ['projects'],
    queryFn: ({ pageParam }) => api.projects.list({ cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })

  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (q.error) throw q.error
  const rows = q.data?.pages.flatMap((p) => p.projects) ?? []
  if (rows.length === 0) return <p className="text-muted-foreground">No projects yet.</p>

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                <Link to={`/projects/${p.id}` as any} className="underline underline-offset-2">
                  {p.name}
                </Link>
              </TableCell>
              <TableCell>
                <code className="text-xs">{p.slug}</code>
              </TableCell>
              <TableCell className="text-muted-foreground">{p.description ?? '—'}</TableCell>
              <TableCell>{new Date(p.updated_at).toLocaleString()}</TableCell>
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
  )
}
