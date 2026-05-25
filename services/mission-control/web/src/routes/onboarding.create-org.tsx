import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';
import { queryClient } from '@/lib/query-client';
import { toast } from 'sonner';
import { messageFor } from '@/lib/error-messages';

export const Route = createFileRoute('/onboarding/create-org')({
  component: CreateOrgRoute,
});

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function CreateOrgRoute() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await (authClient as any).organization.create({
        name,
        slug: slug || slugify(name),
      });
      await authClient.getSession({ query: { disableCookieCache: true } } as any);
      queryClient.clear();
      toast.success('Organization created! Next step: register an agent at /agents.');
      navigate({ to: '/tasks' as any });
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md p-8 bg-card rounded-lg border space-y-4"
      >
        <h1 className="text-2xl font-bold">Create your organization</h1>
        <p className="text-sm text-muted-foreground">
          One operator org per team. You can switch between orgs after.
        </p>
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
            required
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            pattern="[a-z0-9-]+"
            required
          />
          <p className="text-xs text-muted-foreground">Lowercase letters, digits, hyphens.</p>
        </div>
        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? 'Creating…' : 'Create organization'}
        </Button>
      </form>
    </div>
  );
}
