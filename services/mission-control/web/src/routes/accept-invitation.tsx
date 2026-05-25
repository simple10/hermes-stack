import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { authClient } from '@/lib/auth-client';
import { toast } from 'sonner';
import { messageFor } from '@/lib/error-messages';

const searchSchema = z.object({ token: z.string().optional() });

export const Route = createFileRoute('/accept-invitation')({
  validateSearch: searchSchema,
  component: AcceptInvitationRoute,
});

function AcceptInvitationRoute() {
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'pending' | 'ok' | 'error' | 'no-token'>(
    token ? 'pending' : 'no-token',
  );

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        await (authClient as any).organization.acceptInvitation({ invitationId: token });
        toast.success('Invitation accepted');
        setStatus('ok');
        setTimeout(() => navigate({ to: '/tasks' as any }), 1000);
      } catch (e) {
        toast.error(messageFor(e));
        setStatus('error');
      }
    })();
  }, [token, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="w-full max-w-md p-8 bg-card rounded-lg border">
        <h1 className="text-2xl font-bold mb-2">
          {status === 'no-token' && 'Missing invitation token'}
          {status === 'pending' && 'Accepting invitation…'}
          {status === 'ok' && 'Invitation accepted'}
          {status === 'error' && 'Could not accept invitation'}
        </h1>
        <p className="text-muted-foreground">
          {status === 'no-token' && 'The invitation link is missing its token. Check your email and click the link again.'}
          {status === 'pending' && 'One moment…'}
          {status === 'ok' && 'Redirecting you to MissionControl…'}
          {status === 'error' && 'The link may have expired. Ask the inviter for a fresh one.'}
        </p>
      </div>
    </div>
  );
}
