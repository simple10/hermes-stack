import { createFileRoute } from '@tanstack/react-router';
import { ConnectorDetail } from '@/components/connectors/connector-detail';

export const Route = createFileRoute('/_authed/connectors/$connectorId')({
  component: ConnectorDetailRoute,
});

function ConnectorDetailRoute() {
  const { connectorId } = Route.useParams();
  return <ConnectorDetail connectorId={connectorId} />;
}
