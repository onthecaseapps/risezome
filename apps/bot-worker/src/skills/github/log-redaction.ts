/**
 * Header / URL / string redaction helpers used by the GithubClient.
 *
 * Lifted verbatim from `apps/daemon/src/connectors/log-redaction.ts`.
 * Pure functions, no other dependencies.
 */

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-atlassian-token',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
]);

const SENSITIVE_QUERY_KEYS = new Set(['token', 'access_token', 'api_key', 'key']);

const REDACTED = '[REDACTED]';

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      out[name] = REDACTED;
    } else {
      out[name] = value;
    }
  }
  return out;
}

export function redactUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.set(key, REDACTED);
    }
  }
  return url.toString();
}

export function redactString(input: string, secrets: readonly string[]): string {
  let out = input;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}
