import { ReactNode } from 'react'
import { TopBar } from './top-bar'
import { Sidebar } from './sidebar'
import { ThemeProvider } from './theme-provider'
import { ErrorBoundary } from './error-boundary'

/**
 * AppShell — outer layout for all authenticated routes.
 * Wraps with ThemeProvider, renders TopBar + Sidebar + main outlet area
 * with an ErrorBoundary catching render-time errors.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <div className="min-h-screen flex flex-col">
        <TopBar />
        <div className="flex-1 flex">
          <Sidebar />
          <main className="flex-1 p-6 overflow-auto">
            <ErrorBoundary>{children}</ErrorBoundary>
          </main>
        </div>
      </div>
    </ThemeProvider>
  )
}
