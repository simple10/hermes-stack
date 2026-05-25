import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export const Route = createFileRoute('/_authed/tasks/$taskId')({
  component: TaskDetailRoute,
})

function TaskDetailRoute() {
  const { taskId } = Route.useParams()
  const { data, isLoading } = useQuery({
    queryKey: ['tasks', taskId],
    queryFn: () => api.tasks.get(taskId),
  })
  const { data: refsData } = useQuery({
    queryKey: ['tasks', taskId, 'external-refs'],
    queryFn: () => api.externalRefs.list({ resource_type: 'task', resource_id: taskId }),
  })

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (!data) return <p>Not found.</p>
  const { task, comments, events } = data
  const externalRefs = refsData?.external_refs ?? []

  return (
    <div className="space-y-6 max-w-4xl">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{task.title}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Project{' '}
            <Link to={`/projects/${task.project_id}` as any} className="underline">
              {task.project_id}
            </Link>
            {task.agent_id && (
              <>
                {' '}
                • Agent{' '}
                <Link to={`/agents/${task.agent_id}` as any} className="underline">
                  {task.agent_id}
                </Link>
              </>
            )}{' '}
            • Updated {new Date(task.updated_at).toLocaleString()}
          </p>
        </div>
        <Badge>{task.status}</Badge>
      </header>

      {task.body && (
        <div className="prose prose-sm dark:prose-invert max-w-none border rounded p-4">
          <ReactMarkdown>{task.body}</ReactMarkdown>
        </div>
      )}

      <Tabs defaultValue="comments">
        <TabsList>
          <TabsTrigger value="comments">Comments ({comments.length})</TabsTrigger>
          <TabsTrigger value="events">Events ({events.length})</TabsTrigger>
          <TabsTrigger value="refs">External refs ({externalRefs.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="comments" className="space-y-3">
          {comments.length === 0 ? (
            <p className="text-muted-foreground">No comments yet.</p>
          ) : (
            comments.map((c) => (
              <div key={c.id} className="border rounded p-3">
                <div className="text-xs text-muted-foreground">
                  {c.author_type}:{c.author_id} • {new Date(c.created_at).toLocaleString()}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="events" className="space-y-2">
          {events.length === 0 ? (
            <p className="text-muted-foreground">No events.</p>
          ) : (
            events.map((e) => (
              <div key={e.id} className="border rounded p-2 text-sm">
                <div>
                  <strong>{e.kind}</strong> • {e.actor_type ?? '—'}:{e.actor_id ?? ''} •{' '}
                  {new Date(e.created_at).toLocaleString()}
                </div>
                {e.payload && Object.keys(e.payload as any).length > 0 && (
                  <pre className="mt-1 bg-muted p-2 rounded text-xs overflow-auto">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                )}
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="refs" className="space-y-2">
          {externalRefs.length === 0 ? (
            <p className="text-muted-foreground">No external refs.</p>
          ) : (
            externalRefs.map((r) => (
              <div key={r.id} className="border rounded p-2 text-sm">
                <code className="text-xs">
                  {r.source_kind}:{r.source_id}
                </code>
                {' → '}
                {r.external_url ? (
                  <a href={r.external_url} target="_blank" rel="noreferrer" className="underline">
                    {r.external_id}
                  </a>
                ) : (
                  <span>{r.external_id}</span>
                )}
              </div>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
