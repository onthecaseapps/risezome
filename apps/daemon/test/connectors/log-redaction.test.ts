import { describe, expect, it } from 'vitest';
import { redactHeaders, redactString, redactUrl } from '../../src/connectors/log-redaction.js';

describe('log-redaction', () => {
  describe('redactHeaders', () => {
    it('scrubs Authorization, Cookie, and X-API-Key', () => {
      const out = redactHeaders({
        Authorization: 'Bearer secret-pat',
        Cookie: 'session=abc',
        'X-API-Key': 'k',
        'Content-Type': 'application/json',
      });
      expect(out.Authorization).toBe('[REDACTED]');
      expect(out.Cookie).toBe('[REDACTED]');
      expect(out['X-API-Key']).toBe('[REDACTED]');
      expect(out['Content-Type']).toBe('application/json');
    });

    it('is case-insensitive on header name', () => {
      const out = redactHeaders({ authorization: 'Bearer x' });
      expect(out.authorization).toBe('[REDACTED]');
    });
  });

  describe('redactUrl', () => {
    it('scrubs token, access_token, and api_key query params', () => {
      const out = redactUrl('https://example.com/x?token=secret&safe=1&api_key=k');
      expect(out).toContain('token=%5BREDACTED%5D');
      expect(out).toContain('safe=1');
      expect(out).toContain('api_key=%5BREDACTED%5D');
    });

    it('returns input unchanged for non-URL strings', () => {
      expect(redactUrl('not a url')).toBe('not a url');
    });
  });

  describe('redactString', () => {
    it('replaces known secret substrings with [REDACTED]', () => {
      const out = redactString('the token is abc-123 and the cookie is xyz', ['abc-123', 'xyz']);
      expect(out).toBe('the token is [REDACTED] and the cookie is [REDACTED]');
    });

    it('skips empty secrets', () => {
      expect(redactString('hello', [''])).toBe('hello');
    });
  });
});
