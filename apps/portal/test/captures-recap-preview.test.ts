import { describe, it, expect } from 'vitest';
import { structuredRecapOverview } from '../app/(authed)/captures/_recap-preview';

describe('structuredRecapOverview (U5)', () => {
  it('returns the overview from a structured recap JSON', () => {
    const json = JSON.stringify({
      overview: 'We chose the AI stack.',
      topics: [],
      decisions: [],
      action_items: [],
      participants: [],
      speakerCount: 0,
    });
    expect(structuredRecapOverview(json)).toBe('We chose the AI stack.');
  });

  it('returns null for an empty/whitespace overview (caller falls back to markdown)', () => {
    expect(structuredRecapOverview(JSON.stringify({ overview: '   ' }))).toBeNull();
    expect(structuredRecapOverview(JSON.stringify({ topics: [] }))).toBeNull();
  });

  it('returns null for a non-JSON string (caller falls back to markdown, never throws)', () => {
    expect(structuredRecapOverview('## Overview\nlegacy markdown')).toBeNull();
    expect(structuredRecapOverview('')).toBeNull();
  });
});
