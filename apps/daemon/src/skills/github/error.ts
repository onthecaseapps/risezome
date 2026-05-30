import { ConnectorAuthError, RateLimitedError } from '../../connectors/contract.js';
import { SkillExecutionError, type SkillExecutionCode } from '../contract.js';

/**
 * Maps an error thrown by `GithubClient` into a `SkillExecutionError`
 * carrying a telemetry-grade `executionCode`. The source error's
 * `message` is preserved verbatim so `GithubClient`'s token-redaction
 * (via `redactString`) survives the wrap — never reconstruct a fresh
 * message from raw API response content here.
 *
 * Discriminates by `ConnectorAuthError.status` (populated by
 * `GithubClient.get` since the U1 contract extension), NOT by parsing
 * the message string. 404 → `not-found`; 401/403 → `auth-error`;
 * `RateLimitedError` → `rate-limit`; everything else → `unknown`.
 */
export function mapGithubError(err: unknown, skillName: string): SkillExecutionError {
  const code = classify(err);
  const message = err instanceof Error ? err.message : String(err);
  return new SkillExecutionError(skillName, message, { executionCode: code });
}

function classify(err: unknown): SkillExecutionCode {
  if (err instanceof RateLimitedError) return 'rate-limit';
  if (err instanceof ConnectorAuthError) {
    if (err.status === 404) return 'not-found';
    if (err.status === 401 || err.status === 403) return 'auth-error';
    return 'unknown';
  }
  return 'unknown';
}
