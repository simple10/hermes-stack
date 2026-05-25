import { authClient, useListOrganizations, useSession } from '@/lib/auth-client';
import { queryClient } from '@/lib/query-client';
import { useRouter } from '@tanstack/react-router';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function OrgSwitcher() {
  const { data: orgs } = useListOrganizations() as any;
  const { data: session } = useSession() as any;
  const router = useRouter();
  const activeId: string = session?.session?.activeOrganizationId ?? '';

  const switchTo = async (orgId: string) => {
    if (!orgId || orgId === activeId) return;
    await (authClient as any).organization.setActive({ organizationId: orgId });
    // Refetch session so client cache reflects the new active-org id before
    // any subsequent queries fire.
    await authClient.getSession({ query: { disableCookieCache: true } } as any);
    queryClient.clear();
    router.invalidate();
  };

  if (!orgs || orgs.length === 0) return null;

  return (
    <Select value={activeId} onValueChange={switchTo}>
      <SelectTrigger className="w-[220px]">
        <SelectValue placeholder="Select organization" />
      </SelectTrigger>
      <SelectContent>
        {orgs.map((o: { id: string; name: string }) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
