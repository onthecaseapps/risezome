import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WaitlistForm } from '../app/components/waitlist-form';

describe('WaitlistForm (U7)', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call not allowed in presentation-only form');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a success state for a valid email', async () => {
    const user = userEvent.setup();
    render(<WaitlistForm />);
    await user.type(screen.getByLabelText(/work email/i), 'dev@company.com');
    await user.click(screen.getByRole('button', { name: /request access/i }));

    expect(screen.getByRole('status')).toHaveTextContent(/you're on the list/i);
    expect(screen.getByText(/dev@company\.com/)).toBeInTheDocument();
  });

  it('rejects a malformed email with a described error and no success', async () => {
    const user = userEvent.setup();
    render(<WaitlistForm />);
    const input = screen.getByLabelText(/work email/i);
    await user.type(input, 'notanemail');
    await user.click(screen.getByRole('button', { name: /request access/i }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // The error message is wired to the input via aria-describedby.
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(/valid email/i);
  });

  it('requires an email when submitting empty', async () => {
    const user = userEvent.setup();
    render(<WaitlistForm />);
    await user.click(screen.getByRole('button', { name: /request access/i }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/enter your email/i)).toBeInTheDocument();
  });

  it('clears the error once the user edits the field again', async () => {
    const user = userEvent.setup();
    render(<WaitlistForm />);
    const input = screen.getByLabelText(/work email/i);
    await user.click(screen.getByRole('button', { name: /request access/i }));
    expect(screen.getByText(/enter your email/i)).toBeInTheDocument();

    await user.type(input, 'a');
    expect(screen.queryByText(/enter your email/i)).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('never issues a network request (presentation-only)', async () => {
    const user = userEvent.setup();
    render(<WaitlistForm />);
    await user.type(screen.getByLabelText(/work email/i), 'dev@company.com');
    await user.click(screen.getByRole('button', { name: /request access/i }));

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
