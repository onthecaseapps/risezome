import { UpwellError } from '@upwell/shared-types';
import type { CanonicalChunk, CanonicalDoc } from '../corpus/types.js';

export class ConnectorError extends UpwellError {}

export class ConnectorAuthError extends ConnectorError {
  readonly requiredScopes: readonly string[];
  /**
   * HTTP status code from the upstream response when known (401, 403, 404,
   * or other non-ok). Lets typed callers branch on the actual code instead
   * of parsing the message string. Optional for backwards compatibility
   * with existing callers that don't set it.
   */
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

export type AuthMode = 'pat' | 'oauth2-pkce' | 'oauth2-app';

export type AuthResult =
  | { readonly kind: 'pat'; readonly token: string }
  | {
      readonly kind: 'oauth2';
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly expiresAt?: number;
    };

export interface AuthOutcome {
  readonly ok: boolean;
  readonly reason?: 'insufficient-scope' | 'invalid-credentials' | 'network';
  readonly grantedScopes: readonly string[];
  readonly missingScopes: readonly string[];
  readonly identity?: { readonly login: string; readonly url?: string };
}

export interface ScopeDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly type: string;
  readonly metadata?: Record<string, unknown>;
}

export interface DeltaPage {
  readonly docs: readonly CanonicalDoc[];
  readonly chunks: readonly CanonicalChunk[];
  readonly nextCursor: string | null;
}

export interface ConnectorManifest {
  readonly id: string;
  readonly displayName: string;
  readonly authModes: readonly AuthMode[];
  readonly domains: readonly ('text' | 'code')[];
  readonly aclModel: 'doc-scoped' | 'scope-scoped' | 'none';
}

export interface Connector {
  readonly manifest: ConnectorManifest;
  authenticate(auth: AuthResult): Promise<AuthOutcome>;
  listScopes(auth: AuthResult): Promise<readonly ScopeDescriptor[]>;
  pullDelta(auth: AuthResult, scope: ScopeDescriptor, cursor: string | null): Promise<DeltaPage>;
  getDoc(auth: AuthResult, docId: string): Promise<CanonicalDoc | null>;
}
