import { describe, expect, it } from 'vitest';
import { mapGithubError } from '../../../src/skills/github/error.js';
import { SkillExecutionError } from '@risezome/engine/skills';
import { ConnectorAuthError, RateLimitedError } from '../../../src/skills/github/connector-errors.js';

describe('mapGithubError', () => {
  it('RateLimitedError → executionCode rate-limit', () => {
    const err = mapGithubError(new RateLimitedError('throttled', 60_000), 'github_issue_assignees');
    expect(err).toBeInstanceOf(SkillExecutionError);
    expect(err.executionCode).toBe('rate-limit');
    expect(err.skillName).toBe('github_issue_assignees');
  });

  it('ConnectorAuthError with status 404 → not-found', () => {
    const err = mapGithubError(
      new ConnectorAuthError('GitHub request failed (404): not found', [], { status: 404 }),
      'github_issue_progress',
    );
    expect(err.executionCode).toBe('not-found');
  });

  it('ConnectorAuthError with status 401 → auth-error', () => {
    const err = mapGithubError(
      new ConnectorAuthError('GitHub auth failed (401)', [], { status: 401 }),
      'github_issue_assignees',
    );
    expect(err.executionCode).toBe('auth-error');
  });

  it('ConnectorAuthError with status 403 → auth-error', () => {
    const err = mapGithubError(
      new ConnectorAuthError('GitHub auth failed (403)', [], { status: 403 }),
      'github_issue_assignees',
    );
    expect(err.executionCode).toBe('auth-error');
  });

  it('ConnectorAuthError with unknown status → unknown', () => {
    const err = mapGithubError(
      new ConnectorAuthError('GitHub request failed (500)', [], { status: 500 }),
      'github_issue_assignees',
    );
    expect(err.executionCode).toBe('unknown');
  });

  it('generic Error → unknown', () => {
    const err = mapGithubError(new Error('socket hang up'), 'github_issue_assignees');
    expect(err.executionCode).toBe('unknown');
  });

  it('non-Error (string) input → unknown', () => {
    const err = mapGithubError('something bad', 'github_issue_assignees');
    expect(err.executionCode).toBe('unknown');
    expect(err.message).toBe('something bad');
  });

  it('preserves source error message verbatim (token redaction survives the chain)', () => {
    // GithubClient already redacts the token in its error messages via redactString.
    // mapGithubError must NOT reconstruct the message — preserving the source
    // means the redaction is intact end-to-end.
    const redactedSource = 'GitHub auth failed (401): {"message":"Bad credentials"} [token: REDACTED]';
    const err = mapGithubError(
      new ConnectorAuthError(redactedSource, [], { status: 401 }),
      'github_issue_assignees',
    );
    expect(err.message).toBe(redactedSource);
    expect(err.message).not.toContain('ghp_');
  });
});
