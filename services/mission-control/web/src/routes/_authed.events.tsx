import { createFileRoute, Link } from '@tanstack/react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { z } from 'zod'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const searchSchema = z.object({
  kinds: z.string().optional(),
  since: z.coerce.number().int().nonnegative().optional(),
})

export const Route = createFileRoute('/_authed/events')({
  validateSearch: searchSchema,
  component: EventsRoute,
})

function EventsRoute() {
  const filters = Route.useSearch()
  const navigate = Route.useNavigate()

  const q = useInfiniteQuery({
    queryKey: ['events', filters],
    queryFn: ({ pageParam }) =>
      api.events.list({ ...filters, cursor: pageParam as string | undefined, order: 'desc' }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: 30_000,
  })

  const events = q.data?.pages.flatMap((p) => p.events) ?? []
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    overscan: 8,
  })
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  if (q.error) throw q.error

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Events</h1>

      <form
        className="flex flex-wrap gap-2 items-end border rounded p-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="space-y-1">
          <Label htmlFor="f-kinds" className="text-xs">
            Kinds (comma-separated)
          </Label>
          <Input
            id="f-kinds"
            defaultValue={filters.kinds ?? ''}
            onChange={(e) =>
              navigate({ search: (s: any) => ({ ...s, kinds: e.target.value || undefined }) })
            }
            placeholder="task,project"
            className="w-64"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-since" className="text-xs">
            Since (event id)
          </Label>
          <Input
            id="f-since"
            type="number"
            min="0"
            defaultValue={filters.since ?? ''}
            onChange={(e) =>
              navigate({
                search: (s: any) => ({
                  ...s,
                  since: e.target.value ? parseInt(e.target.value, 10) : undefined,
                }),
              })
            }
            className="w-32"
          />
        </div>
        <Button type="button" variant="outline" onClick={() => navigate({ search: {} as any })}>
          Clear filters
        </Button>
      </form>

      {q.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : events.length === 0 ? (
        <p className="text-muted-foreground">No events.</p>
      ) : (
        <div ref={parentRef} className="h-[600px] overflow-auto border rounded">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const e = events[vi.index]!
              const isOpen = expanded.has(e.id)
              return (
                <div
                  key={e.id}
                  style={{ position: 'absolute', top: vi.start, left: 0, right: 0 }}
                  className="p-3 border-b"
                >
                  <div className="flex items-baseline justify-between">
                    <div>
                      <strong>{e.kind}</strong> on{' '}
                      <Link
                        to={`/${e.resource_type}s/${e.resource_id}` as any}
                        className="underline underline-offset-2"
                      >
                        {e.resource_type}:{e.resource_id}
                      </Link>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(e.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {e.actor_type ?? '—'}:{e.actor_id ?? ''} • id={e.id}
                  </div>
                  <button
                    className="text-xs underline mt-1"
                    onClick={() => {
                      const s = new Set(expanded)
                      if (s.has(e.id)) s.delete(e.id)
                      else s.add(e.id)
                      setExpanded(s)
                    }}
                  >
                    {isOpen ? 'Hide' : 'Show'} payload
                  </button>
                  {isOpen && (
                    <pre className="mt-2 bg-muted p-2 rounded text-xs overflow-auto">
                      {JSON.stringify(e.payload, null, 2)}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {q.hasNextPage && (
        <Button variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
