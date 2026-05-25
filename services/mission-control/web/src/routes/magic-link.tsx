import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/magic-link')({
  component: MagicLinkRoute,
})

/**
 * Landing page for magic-link sign-in. The link in the email handles auth
 * server-side; if you opened this directly the link wasn't clicked yet.
 */
function MagicLinkRoute() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="w-full max-w-md p-8 bg-card rounded-lg border">
        <h1 className="text-2xl font-bold mb-2">Check your email</h1>
        <p className="text-muted-foreground mb-4">
          We sent you a sign-in link. Click the link in the email to continue.
        </p>
        <p className="text-sm text-muted-foreground">
          Already signed in?{' '}
          <Link to={'/' as any} className="underline">
            Go to MissionControl
          </Link>
          .
        </p>
      </div>
    </div>
  )
}
