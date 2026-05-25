import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { KeyRevealModal } from '@/components/shared/key-reveal-modal';

describe('KeyRevealModal', () => {
  it('renders the key string when open', () => {
    render(<KeyRevealModal open={true} keyValue="mcpat_abc123xyz" onClose={() => {}} />);
    expect(screen.getByText(/mcpat_abc123xyz/)).toBeInTheDocument();
    expect(screen.getByText(/only time/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<KeyRevealModal open={false} keyValue="mcpat_hidden" onClose={() => {}} />);
    expect(screen.queryByText(/mcpat_hidden/)).not.toBeInTheDocument();
  });

  it('uses custom title when provided', () => {
    render(<KeyRevealModal open={true} keyValue="x" onClose={() => {}} title="Agent key" />);
    expect(screen.getByText('Agent key')).toBeInTheDocument();
  });

  it('Done button invokes onClose', () => {
    const onClose = vi.fn();
    render(<KeyRevealModal open={true} keyValue="x" onClose={onClose} />);
    fireEvent.click(screen.getByText(/Done/i));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
