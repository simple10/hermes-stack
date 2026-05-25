import { createFileRoute, Link, Outlet } from '@tanstack/react-router'

const LINKS = [
  { to: '/settings/profile', label: 'Profile' },
  { to: '/settings/sessions', label: 'Sessions' },
  { to: '/settings/api-keys', label: 'API Keys' },
  { to: '/settings/organization', label: 'Organization' },
  { to: '/settings/organization/members', label: 'Members' },
  { to: '/settings/organization/invitations', label: 'Invitations' },
]

export const Route = createFileRoute('/_authed/settings')({
  component: SettingsLayout,
})

function SettingsLayout() {
  return (
    <div className="flex gap-8 max-w-5xl">
      <nav className="w-48 space-y-1 shrink-0">
        {LINKS.map((l) => (
          <Link
            key={l.to}
            to={l.to as any}
            className="block px-3 py-2 rounded text-sm hover:bg-muted [&.active]:bg-muted [&.active]:font-semibold"
            activeProps={{ className: 'active' }}
          >
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  )
}
