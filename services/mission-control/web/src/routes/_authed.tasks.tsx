import { createFileRoute, Link } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { TaskStatus } from '@mc/schemas/common'
import { api } from '@/lib/api'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const searchSchema = z.object({
  project_id: z.string().optional(),
  agent_id: z.string().optional(),
  status: z.union([TaskStatus, z.array(TaskStatus)]).optional(),
  updated_since: z.string().optional(),
})

export const Route = createFileRoute('/_authed/tasks')({
  validateSearch: searchSchema,
  component: TasksRoute,
})

function TasksRoute() {
  const filters = Route.useSearch()
  const navigate = Route.useNavigate()

  // Side queries to resolve project + agent names client-side.
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list({ limit: 100 }),
  })
  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list({ limit: 100 }),
  })

  const projectName = (id: string) => projects?.projects.find((p) => p.id === id)?.name ?? id
  const agentName = (id: string | null) =>
    id ? (agents?.agents.find((a) => a.id === id)?.name ?? id) : '—'

  const q = useInfiniteQuery({
    queryKey: ['tasks', filters],
    queryFn: ({ pageParam }) =>
      api.tasks.list({ ...filters, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })

  const rows = q.data?.pages.flatMap((p) => p.tasks) ?? []

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Tasks</h1>

      <form
        className="flex flex-wrap gap-2 items-end border rounded p-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="space-y-1">
          <Label htmlFor="f-project" className="text-xs">
            Project ID
          </Label>
          <Input
            id="f-project"
            defaultValue={filters.project_id ?? ''}
            onChange={(e) =>
              navigate({ search: (s: any) => ({ ...s, project_id: e.target.value || undefined }) })
            }
            placeholder="prj_…"
            className="w-48"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-agent" className="text-xs">
            Agent ID
          </Label>
          <Input
            id="f-agent"
            defaultValue={filters.agent_id ?? ''}
            onChange={(e) =>
              navigate({ search: (s: any) => ({ ...s, agent_id: e.target.value || undefined }) })
            }
            placeholder="agt_…"
            className="w-48"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-status" className="text-xs">
            Status
          </Label>
          <select
            id="f-status"
            defaultValue={(filters.status as string) ?? ''}
            onChange={(e) =>
              navigate({ search: (s: any) => ({ ...s, status: e.target.value || undefined }) })
            }
            className="block rounded border bg-background px-3 py-2 text-sm"
          >
            <option value="">any</option>
            {['pending', 'ready', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled'].map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ),
            )}
          </select>
        </div>
        <Button type="button" variant="outline" onClick={() => navigate({ search: {} as any })}>
          Clear filters
        </Button>
      </form>

      {q.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground">No tasks match these filters.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link to={`/tasks/${t.id}` as any} className="underline underline-offset-2">
                      {t.title}
                    </Link>
                  </TableCell>
                  <TableCell>{projectName(t.project_id)}</TableCell>
                  <TableCell>{agentName(t.agent_id)}</TableCell>
                  <TableCell>
                    <Badge>{t.status}</Badge>
                  </TableCell>
                  <TableCell>{t.priority}</TableCell>
                  <TableCell title={t.updated_at}>
                    {new Date(t.updated_at).toLocaleString()}
                  </TableCell>
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
      )}
    </div>
  )
}
