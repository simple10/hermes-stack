import { createFileRoute } from '@tanstack/react-router';
import { ForgotPassword } from '@/components/auth/forgot-password';

export const Route = createFileRoute('/forgot-password' as any)({
  component: ForgotPasswordRoute,
});

function ForgotPasswordRoute() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="w-full max-w-md p-4">
        <ForgotPassword />
      </div>
    </div>
  );
}
