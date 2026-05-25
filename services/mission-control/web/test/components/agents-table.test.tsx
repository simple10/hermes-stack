import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, vi } from 'vitest';
import { server } from '../setup';
import { AgentsTable } from '@/components/agents/agents-table';
import React from 'react';

// Stub TanStack Router's Link to a plain anchor so we don't need a router context.
vi.mock('@tanstack/react-router', async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    Link: ({ children, to, className }: any) => (
      <a href={typeof to === 'string' ? to : '#'} className={className}>
        {children}
      </a>
    ),
  };
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('AgentsTable', () => {
  it('shows empty state when no agents', async () => {
    // Default handler in test/handlers.ts already returns []; nothing to override.
    wrap(<AgentsTable />);
    await waitFor(() =>
      expect(screen.getByText(/No agents yet/i)).toBeInTheDocument(),
    );
  });

  it('renders rows from the API', async () => {
    server.use(
      http.get('/api/v1/agents', () =>
        HttpResponse.json({
          agents: [
            {
              id: 'agt_1',
              org_id: 'org_x',
              name: 'hermes-vm1',
              kind: 'hermes',
              description: null,
              last_seen_at: null,
              created_by_user_id: null,
              created_at: '2026-05-24T12:00:00.000Z',
              updated_at: '2026-05-24T12:00:00.000Z',
              deleted_at: null,
              deleted_by_type: null,
              deleted_by_id: null,
            },
          ],
          next_cursor: null,
        }),
      ),
    );
    wrap(<AgentsTable />);
    await waitFor(() => expect(screen.getByText('hermes-vm1')).toBeInTheDocument());
    expect(screen.getByText('hermes')).toBeInTheDocument();
  });
});
