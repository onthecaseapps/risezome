/**
 * Slimmed connector-side error + auth-result types used by the
 * live-API GitHub skills.
 *
 * Lifted from `apps/daemon/src/connectors/contract.ts` but trimmed to
 * the surface the live skills actually use: error classes for auth +
 * rate-limit failures, and the `AuthResult` shape the GithubClient
 * passes through. The full daemon Connector interface (pullDelta,
 * listScopes, etc.) doesn't carry into the bot-worker because
 * indexing lives in the portal's Inngest functions (U5).
 *
 * When this code consolidates back to a shared `packages/connectors-github/`
 * package (forcing function: next GitHub-client bug fix), these types
 * move there alongside the client.
 */

import { RisezomeError } from '@risezome/shared-types';

export class ConnectorError extends RisezomeError {}

export class ConnectorAuthError extends ConnectorError {
  readonly requiredScopes: readonly string[];
  readonly status: number | undefined;
  constructor(
    message: string,
    requiredScopes: readonly string[] = [],
    options?: ErrorOptions & { status?: number },
  ) {
    super('connector-auth', message, options);
    this.requiredScopes = requiredScopes;
    this.status = options?.status;
  }
}

export class RateLimitedError extends ConnectorError {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number, options?: ErrorOptions) {
    super('connector-rate-limited', message, options);
    this.retryAfterMs = retryAfterMs;
  }
}

export type AuthResult =
  | { readonly kind: 'pat'; readonly token: string }
  | {
      readonly kind: 'oauth2';
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly expiresAt?: number;
    };
