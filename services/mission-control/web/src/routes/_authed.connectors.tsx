import { createFileRoute } from '@tanstack/react-router';
import { ConnectorsTable } from '@/components/connectors/connectors-table';
import { RegisterConnectorDialog } from '@/components/connectors/register-connector-dialog';

export const Route = createFileRoute('/_authed/connectors')({
  component: ConnectorsRoute,
});

function ConnectorsRoute() {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Connectors</h1>
        <RegisterConnectorDialog />
      </div>
      <ConnectorsTable />
    </div>
  );
}
