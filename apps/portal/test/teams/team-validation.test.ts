import { describe, it, expect } from 'vitest';
import {
  isDuplicateSlugError,
  slugify,
  validateTeamName,
  validateTeamSlug,
} from '../../app/(authed)/settings/teams/_lib/team-validation';

describe('validateTeamName', () => {
  it('trims and accepts a normal name', () => {
    expect(validateTeamName('  Platform  ')).toEqual({ ok: true, value: 'Platform' });
  });
  it('rejects empty / whitespace-only', () => {
    expect(validateTeamName('   ')).toEqual({ ok: false, error: 'empty_name' });
    expect(validateTeamName(undefined)).toEqual({ ok: false, error: 'empty_name' });
  });
  it('rejects over-long names', () => {
    expect(validateTeamName('x'.repeat(61))).toEqual({ ok: false, error: 'name_too_long' });
  });
});

describe('slugify', () => {
  it('kebab-cases arbitrary text', () => {
    expect(slugify('Growth & Eng!')).toBe('growth-eng');
    expect(slugify('  Q3 2026  ')).toBe('q3-2026');
    expect(slugify('Platform')).toBe('platform');
  });
  it('collapses runs and trims edge dashes', () => {
    expect(slugify('--a__b  c--')).toBe('a-b-c');
  });
});

describe('validateTeamSlug', () => {
  it('accepts a valid kebab slug', () => {
    expect(validateTeamSlug('growth-eng')).toEqual({ ok: true, value: 'growth-eng' });
  });
  it('lowercases + trims input', () => {
    expect(validateTeamSlug('  Platform ')).toEqual({ ok: true, value: 'platform' });
  });
  it('derives from the name when slug is blank', () => {
    expect(validateTeamSlug('', 'Growth Eng')).toEqual({ ok: true, value: 'growth-eng' });
  });
  it('rejects spaces, underscores, leading/trailing/double dashes', () => {
    expect(validateTeamSlug('has space').ok).toBe(false);
    expect(validateTeamSlug('snake_case').ok).toBe(false);
    expect(validateTeamSlug('-lead').ok).toBe(false);
    expect(validateTeamSlug('trail-').ok).toBe(false);
    expect(validateTeamSlug('double--dash').ok).toBe(false);
  });
  it('rejects when neither slug nor a slugifiable name is given', () => {
    expect(validateTeamSlug('', '!!!')).toEqual({ ok: false, error: 'empty_slug' });
  });
  it('rejects over-long slugs', () => {
    expect(validateTeamSlug('a'.repeat(51))).toEqual({ ok: false, error: 'slug_too_long' });
  });
});

describe('isDuplicateSlugError', () => {
  it('matches the named unique constraint', () => {
    expect(
      isDuplicateSlugError('duplicate key value violates unique constraint "teams_org_id_slug_key"'),
    ).toBe(true);
  });
  it('matches generic unique-violation text', () => {
    expect(isDuplicateSlugError('duplicate key value violates unique constraint on slug')).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isDuplicateSlugError('permission denied for table teams')).toBe(false);
  });
});
