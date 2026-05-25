import { Component, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { messageFor } from '@/lib/error-messages';

type State = { error: unknown };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-6 max-w-2xl">
        <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
        <p className="text-muted-foreground mb-4">{messageFor(this.state.error)}</p>
        <Button onClick={() => this.setState({ error: null })}>Retry</Button>
      </div>
    );
  }
}
