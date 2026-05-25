import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { authClient } from '@/lib/auth-client'
import { AppShell } from '@/components/app-shell/app-shell'

export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ location }) => {
    const { data: session } = await authClient.getSession()
    if (!session) {
      throw redirect({
        to: '/sign-in' as any,
        search: { redirect: location.pathname + location.search } as any,
      })
    }
  },
  component: AuthedLayout,
})

function AuthedLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
