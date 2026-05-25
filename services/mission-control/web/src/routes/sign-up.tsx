import { createFileRoute } from '@tanstack/react-router';
import { SignUp } from '@/components/auth/sign-up';

export const Route = createFileRoute('/sign-up' as any)({
  component: SignUpRoute,
});

function SignUpRoute() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="w-full max-w-md p-4">
        <SignUp />
      </div>
    </div>
  );
}
