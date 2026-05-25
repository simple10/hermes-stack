import { createFileRoute } from '@tanstack/react-router';
import { AgentsTable } from '@/components/agents/agents-table';
import { RegisterAgentDialog } from '@/components/agents/register-agent-dialog';

export const Route = createFileRoute('/_authed/agents')({
  component: AgentsRoute,
});

function AgentsRoute() {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Agents</h1>
        <RegisterAgentDialog />
      </div>
      <AgentsTable />
    </div>
  );
}
