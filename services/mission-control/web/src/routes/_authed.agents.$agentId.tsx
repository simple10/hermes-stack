import { createFileRoute } from '@tanstack/react-router'
import { AgentDetail } from '@/components/agents/agent-detail'

export const Route = createFileRoute('/_authed/agents/$agentId')({
  component: AgentDetailRoute,
})

function AgentDetailRoute() {
  const { agentId } = Route.useParams()
  return <AgentDetail agentId={agentId} />
}
