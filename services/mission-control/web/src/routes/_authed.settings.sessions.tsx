import { createFileRoute } from '@tanstack/react-router';
import { ActiveSessions } from '@/components/auth/settings/security/active-sessions';

export const Route = createFileRoute('/_authed/settings/sessions')({
  component: () => <ActiveSessions />,
});
