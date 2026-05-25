import { QueryClient } from '@tanstack/react-query'

/** Singleton QueryClient — see UI design spec §10 for defaults rationale. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})
