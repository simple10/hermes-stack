import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ResetPassword } from '@/components/auth/reset-password';

const searchSchema = z.object({ token: z.string().optional() });

export const Route = createFileRoute('/reset-password' as any)({
  validateSearch: searchSchema,
  component: ResetPasswordRoute,
});

function ResetPasswordRoute() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="w-full max-w-md p-4">
        <ResetPassword />
      </div>
    </div>
  );
}
