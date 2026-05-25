import { Link } from '@tanstack/react-router';
import { Separator } from '@/components/ui/separator';
import { ListTodo, Activity, FolderKanban, Bot, Plug, Settings } from 'lucide-react';

const NAV = [
  { to: '/tasks', label: 'Tasks', icon: ListTodo },
  { to: '/events', label: 'Events', icon: Activity },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/connectors', label: 'Connectors', icon: Plug },
];

export function Sidebar() {
  return (
    <aside className="w-56 border-r bg-muted/30">
      <nav className="p-4 space-y-1">
        {NAV.map((l) => {
          const Icon = l.icon;
          return (
            <Link
              key={l.to}
              to={l.to as any}
              className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-muted text-sm [&.active]:bg-muted [&.active]:font-semibold"
              activeProps={{ className: 'active' }}
            >
              <Icon className="h-4 w-4" />
              {l.label}
            </Link>
          );
        })}
        <Separator className="my-2" />
        <Link
          to={'/settings/profile' as any}
          className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-muted text-sm"
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
      </nav>
    </aside>
  );
}
