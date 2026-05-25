import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter, Link } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen.ts';
import { authClient } from './lib/auth-client.ts';
import { queryClient } from './lib/query-client.ts';
import { AuthProvider } from './components/auth/auth-provider.tsx';
import { Toaster } from 'sonner';
import './index.css';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        authClient={authClient as any}
        navigate={(options: { to: string; replace?: boolean }) =>
          router.navigate({ to: options.to as any, replace: options.replace })
        }
        Link={Link as any}
        redirectTo="/tasks"
      >
        <RouterProvider router={router} />
        <Toaster richColors position="top-right" />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
