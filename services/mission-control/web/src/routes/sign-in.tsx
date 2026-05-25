import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SignIn } from '@/components/auth/sign-in';

const searchSchema = z.object({ redirect: z.string().optional() });

export const Route = createFileRoute('/sign-in' as any)({
  validateSearch: searchSchema,
  component: SignInRoute,
});

function SignInRoute() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="w-full max-w-md p-4">
        <SignIn />
      </div>
    </div>
  );
}
