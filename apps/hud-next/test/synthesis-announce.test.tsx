import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SynthesisAnnounce } from '../app/components/synthesis-announce';

describe('SynthesisAnnounce', () => {
  it('renders an sr-only aria-live=polite container', () => {
    const { container } = render(<SynthesisAnnounce text={null} />);
    const div = container.querySelector('div#synthesis-announce');
    expect(div).not.toBeNull();
    expect(div?.getAttribute('aria-live')).toBe('polite');
    expect(div?.classList.contains('sr-only')).toBe(true);
  });

  it('renders the announce text when provided', () => {
    const { container } = render(<SynthesisAnnounce text="The answer is 42." />);
    expect(container.querySelector('div#synthesis-announce')?.textContent).toBe(
      'The answer is 42.',
    );
  });

  it('renders empty string when text is null', () => {
    const { container } = render(<SynthesisAnnounce text={null} />);
    expect(container.querySelector('div#synthesis-announce')?.textContent).toBe('');
  });
});
