import { OrgSwitcher } from './org-switcher';
import { ThemeToggle } from './theme-toggle';
import { UserButton } from '@/components/auth/user/user-button';

export function TopBar() {
  return (
    <header className="border-b bg-background">
      <div className="flex items-center justify-between px-4 h-14">
        <div className="flex items-center gap-4">
          <span className="font-bold">MissionControl</span>
          <OrgSwitcher />
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <UserButton />
        </div>
      </div>
    </header>
  );
}
