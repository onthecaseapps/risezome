import { describe, expect, it } from 'vitest';
import { sanitizeNext } from '../../app/_lib/safe-next';

describe('sanitizeNext (open-redirect guard)', () => {
  it('allows same-origin relative paths', () => {
    expect(sanitizeNext('/invite/abc')).toBe('/invite/abc');
    expect(sanitizeNext('/upcoming')).toBe('/upcoming');
  });

  it('rejects absolute URLs', () => {
    expect(sanitizeNext('https://evil.example')).toBe('/onboarding');
    expect(sanitizeNext('http://evil.example/x')).toBe('/onboarding');
  });

  it('rejects protocol-relative and scheme tricks', () => {
    expect(sanitizeNext('//evil.example')).toBe('/onboarding');
    expect(sanitizeNext('/\\evil.example')).toBe('/onboarding');
    expect(sanitizeNext('javascript:alert(1)')).toBe('/onboarding');
  });

  it('falls back for empty/null and honors a custom fallback', () => {
    expect(sanitizeNext(null)).toBe('/onboarding');
    expect(sanitizeNext('')).toBe('/onboarding');
    expect(sanitizeNext(null, '/home')).toBe('/home');
  });
});
