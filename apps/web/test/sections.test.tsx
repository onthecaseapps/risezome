import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Hero } from '../app/components/hero';
import { ValueSections } from '../app/components/value-sections';

describe('Hero (U3)', () => {
  it('leads with the proactive headline and a CTA anchoring the waitlist', () => {
    render(<Hero />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/context finds you/i);
    const cta = screen.getByRole('link', { name: /request early access/i });
    expect(cta).toHaveAttribute('href', '#waitlist');
    expect(screen.getByRole('link', { name: /see it live/i })).toHaveAttribute('href', '#demo');
  });
});

describe('ValueSections (U4)', () => {
  it('renders all three value beats', () => {
    render(<ValueSections />);
    expect(screen.getByRole('heading', { name: /live, not after the fact/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /grounded in your tools/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /closes the doc gap/i })).toBeInTheDocument();
  });

  it('renders the how-it-works steps under an anchorable section', () => {
    const { container } = render(<ValueSections />);
    expect(container.querySelector('#how-it-works')).not.toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});
