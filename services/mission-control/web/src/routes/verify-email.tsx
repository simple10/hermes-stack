import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/verify-email')({
  component: VerifyEmailRoute,
})

/**
 * Landing page after a user clicks the verification link in their email.
 * The actual verification happens server-side in better-auth's GET handler
 * for the email link; this route just shows a "you're verified" message.
 */
function VerifyEmailRoute() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="w-full max-w-md p-8 bg-card rounded-lg border">
        <h1 className="text-2xl font-bold mb-2">Email verified</h1>
        <p className="text-muted-foreground mb-4">
          You're all set.{' '}
          <Link to={'/sign-in' as any} className="underline">
            Sign in
          </Link>{' '}
          to continue.
        </p>
      </div>
    </div>
  )
}
