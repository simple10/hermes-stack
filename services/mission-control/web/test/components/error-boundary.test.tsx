import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ErrorBoundary } from '@/components/app-shell/error-boundary'

function Boom(): React.ReactElement {
  throw new Error('kaboom')
}

describe('ErrorBoundary', () => {
  it('catches render errors and shows a friendly fallback with Retry', () => {
    // Silence the React error logging that StrictMode prints.
    const orig = console.error
    console.error = () => {}
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      )
      expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument()
      expect(screen.getByText(/kaboom/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
    } finally {
      console.error = orig
    }
  })

  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <p>healthy child</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText(/healthy child/i)).toBeInTheDocument()
  })
})
