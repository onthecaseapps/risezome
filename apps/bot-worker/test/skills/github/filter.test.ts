import { describe, expect, it } from 'vitest';
import { ftsPhraseQuery } from '../../../src/skills/github/filter.js';

describe('ftsPhraseQuery', () => {
  it('returns null when neither state nor labels are present', () => {
    expect(ftsPhraseQuery({})).toBeNull();
    expect(ftsPhraseQuery({ type: 'issue' })).toBeNull();
    expect(ftsPhraseQuery({ author: 'jamie' })).toBeNull();
    expect(ftsPhraseQuery({ labels: [] })).toBeNull();
  });

  it('emits a single phrase for state alone', () => {
    expect(ftsPhraseQuery({ state: 'open' })).toBe('"Status open"');
    expect(ftsPhraseQuery({ state: 'closed' })).toBe('"Status closed"');
  });

  it('emits a single phrase for a single label', () => {
    expect(ftsPhraseQuery({ labels: ['bug'] })).toBe('"Labels bug"');
  });

  it('AND-joins multiple labels with the implicit websearch space-separator', () => {
    expect(ftsPhraseQuery({ labels: ['bug', 'p0'] })).toBe('"Labels bug" "Labels p0"');
  });

  it('combines state + labels — state first, then labels in order', () => {
    expect(
      ftsPhraseQuery({ state: 'open', labels: ['bug', 'phase-2'] }),
    ).toBe('"Status open" "Labels bug" "Labels phase-2"');
  });

  it('drops empty label strings without breaking the phrase composition', () => {
    expect(ftsPhraseQuery({ labels: ['bug', '', 'p0'] })).toBe(
      '"Labels bug" "Labels p0"',
    );
  });
});
