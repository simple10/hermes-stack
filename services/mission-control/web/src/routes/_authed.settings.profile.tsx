import { createFileRoute } from '@tanstack/react-router';
import { AccountSettings } from '@/components/auth/settings/account/account-settings';

export const Route = createFileRoute('/_authed/settings/profile')({
  component: () => <AccountSettings />,
});
