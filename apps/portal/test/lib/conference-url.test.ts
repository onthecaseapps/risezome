import { describe, expect, it } from 'vitest';
import { normalizeConferenceUrl } from '../../app/_lib/conference-url';

describe('normalizeConferenceUrl', () => {
  it('strips volatile query params and fragments so co-attendees dedup', () => {
    expect(normalizeConferenceUrl('https://zoom.us/j/123?pwd=aaa')).toBe('https://zoom.us/j/123');
    expect(normalizeConferenceUrl('https://zoom.us/j/123?pwd=bbb')).toBe('https://zoom.us/j/123');
  });

  it('normalizes host casing and trailing slashes', () => {
    expect(normalizeConferenceUrl('https://Meet.Google.com/abc-defg-hij/')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
  });

  it('treats two clean identical Meet links as equal', () => {
    const a = normalizeConferenceUrl('https://meet.google.com/abc-defg-hij');
    const b = normalizeConferenceUrl(' https://meet.google.com/abc-defg-hij ');
    expect(a).toBe(b);
  });

  it('keeps distinct meeting paths distinct', () => {
    expect(normalizeConferenceUrl('https://zoom.us/j/111')).not.toBe(
      normalizeConferenceUrl('https://zoom.us/j/222'),
    );
  });

  it('falls back to a trimmed lowercased form for unparseable input', () => {
    expect(normalizeConferenceUrl('  Not A URL  ')).toBe('not a url');
  });
});
