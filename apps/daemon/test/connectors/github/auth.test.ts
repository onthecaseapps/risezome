import { describe, expect, it } from 'vitest';
import {
  GITHUB_REQUIRED_SCOPES,
  auditScopes,
  authenticate,
  parseScopesHeader,
} from '../../../src/connectors/github/auth.js';
import { GithubClient } from '../../../src/connectors/github/client.js';

function buildResponse(
  body: object,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('github/auth', () => {
  describe('parseScopesHeader', () => {
    it('handles missing header', () => {
      expect(parseScopesHeader(null)).toEqual([]);
    });

    it('parses comma-separated scopes with whitespace', () => {
      expect(parseScopesHeader('repo, read:user , user:email')).toEqual([
        'repo',
        'read:user',
        'user:email',
      ]);
    });
  });

  describe('auditScopes', () => {
    it('reports missing scopes when the PAT lacks required ones', () => {
      const audit = auditScopes(['repo']);
      expect(audit.missingScopes).toContain('read:user');
      expect(audit.excessiveScopes).toEqual([]);
    });

    it('treats `user` as covering `read:user`', () => {
      const audit = auditScopes(['repo', 'user']);
      expect(audit.missingScopes).toEqual([]);
    });

    it('reports excessive privileged scopes', () => {
      const audit = auditScopes(['repo', 'read:user', 'admin:org', 'workflow']);
      expect(audit.excessiveScopes).toEqual(['admin:org', 'workflow']);
    });
  });

  describe('authenticate', () => {
    it('returns ok when /user succeeds and scopes are sufficient', async () => {
      const client = new GithubClient({
        fetchImpl: async () =>
          buildResponse(
            { login: 'nathan', html_url: 'https://github.com/nathan' },
            { headers: { 'X-OAuth-Scopes': GITHUB_REQUIRED_SCOPES.join(', ') } },
          ),
      });

      const outcome = await authenticate(client, { kind: 'pat', token: 'gh_pat_test' });
      expect(outcome.ok).toBe(true);
      expect(outcome.identity?.login).toBe('nathan');
      expect(outcome.missingScopes).toEqual([]);
    });

    it('returns ok=false with insufficient-scope when scopes are missing', async () => {
      const client = new GithubClient({
        fetchImpl: async () =>
          buildResponse(
            { login: 'nathan', html_url: 'https://github.com/nathan' },
            { headers: { 'X-OAuth-Scopes': 'public_repo' } },
          ),
      });

      const outcome = await authenticate(client, { kind: 'pat', token: 'gh_pat_test' });
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBe('insufficient-scope');
      expect(outcome.missingScopes.length).toBeGreaterThan(0);
    });

    it('returns ok=false with invalid-credentials on 401', async () => {
      const client = new GithubClient({
        fetchImpl: async () =>
          new Response('Bad credentials', {
            status: 401,
            headers: { 'X-RateLimit-Remaining': '4999' },
          }),
      });
      const outcome = await authenticate(client, { kind: 'pat', token: 'gh_pat_test' });
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBe('invalid-credentials');
    });
  });
});
