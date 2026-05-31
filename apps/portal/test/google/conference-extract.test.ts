import { describe, expect, it } from 'vitest';
import { extractConference } from '../../app/_lib/conference-extract';

describe('extractConference', () => {
  describe('structured conferenceData path', () => {
    it('pulls a Google Meet URL from hangoutsMeet conferenceData', () => {
      const result = extractConference({
        conferenceData: {
          entryPoints: [
            { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
            { entryPointType: 'phone', uri: 'tel:+15551234567' },
          ],
          conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
        },
      });
      expect(result).toEqual({ url: 'https://meet.google.com/abc-defg-hij', platform: 'meet' });
    });

    it('pulls a Zoom URL from addOn conferenceData (Zoom add-on)', () => {
      const result = extractConference({
        conferenceData: {
          entryPoints: [
            { entryPointType: 'video', uri: 'https://us02web.zoom.us/j/1234567890?pwd=abc' },
          ],
          conferenceSolution: { key: { type: 'addOn' }, name: 'Zoom Meeting' },
        },
      });
      expect(result.url).toBe('https://us02web.zoom.us/j/1234567890?pwd=abc');
      expect(result.platform).toBe('zoom');
    });

    it('returns null platform when conferenceData has no video entry point', () => {
      const result = extractConference({
        conferenceData: {
          entryPoints: [{ entryPointType: 'phone', uri: 'tel:+15551234567' }],
        },
      });
      expect(result).toEqual({ url: null, platform: null });
    });
  });

  describe('regex fallback path', () => {
    it('extracts a Zoom URL pasted into the location field', () => {
      const result = extractConference({
        location: 'https://us02web.zoom.us/j/9876543210',
      });
      expect(result.url).toBe('https://us02web.zoom.us/j/9876543210');
      expect(result.platform).toBe('zoom');
    });

    it('extracts a Meet URL pasted into the description (multi-line)', () => {
      const result = extractConference({
        description:
          'Agenda:\n1. Roadmap review\n2. Q&A\n\nJoin: https://meet.google.com/qqq-rrrr-sss\nDoc: https://docs.google.com/document/d/xyz',
      });
      expect(result.url).toBe('https://meet.google.com/qqq-rrrr-sss');
      expect(result.platform).toBe('meet');
    });

    it('prefers zoom/meet URLs even when generic links appear first', () => {
      // Generic docs link before the actual meeting link.
      const result = extractConference({
        description:
          'Pre-read: https://docs.google.com/doc1\nJoin: https://us05web.zoom.us/j/abc',
      });
      expect(result.platform).toBe('zoom');
      expect(result.url).toBe('https://us05web.zoom.us/j/abc');
    });

    it('falls back to a Teams/Webex-style URL as platform "other"', () => {
      const result = extractConference({
        location: 'https://teams.microsoft.com/l/meetup-join/abcdef',
      });
      expect(result.url).toBe('https://teams.microsoft.com/l/meetup-join/abcdef');
      expect(result.platform).toBe('other');
    });

    it('trims trailing punctuation eaten by sentence-final periods', () => {
      const result = extractConference({
        description: 'Hop on at https://meet.google.com/aaa-bbbb-ccc.',
      });
      expect(result.url).toBe('https://meet.google.com/aaa-bbbb-ccc');
    });
  });

  describe('no conference at all', () => {
    it('returns nulls for an in-person meeting', () => {
      expect(extractConference({ location: '123 Main St, Brooklyn NY' })).toEqual({
        url: null,
        platform: null,
      });
    });

    it('returns nulls for a meeting with no location and no description', () => {
      expect(extractConference({})).toEqual({ url: null, platform: null });
    });

    it('ignores docs-only URLs (no looks-like-conference match)', () => {
      const result = extractConference({
        description: 'Read this first: https://docs.google.com/document/d/xyz',
      });
      expect(result.url).toBeNull();
    });
  });

  describe('precedence: structured wins over fallback', () => {
    it('uses conferenceData even when description has a different URL', () => {
      const result = extractConference({
        conferenceData: {
          entryPoints: [
            { entryPointType: 'video', uri: 'https://meet.google.com/structured' },
          ],
          conferenceSolution: { key: { type: 'hangoutsMeet' } },
        },
        description: 'old link: https://us02web.zoom.us/j/legacy',
      });
      expect(result.url).toBe('https://meet.google.com/structured');
      expect(result.platform).toBe('meet');
    });
  });
});
