import { createFileRoute, redirect } from '@tanstack/react-router';
import { authClient } from '../lib/auth-client.ts';

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const { data: session } = await authClient.getSession();
    if (session) {
      throw redirect({ to: '/tasks' as any });
    }
    throw redirect({ to: '/sign-in' as any });
  },
});
