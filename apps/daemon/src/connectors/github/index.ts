import type {
  AuthOutcome,
  AuthResult,
  Connector,
  ConnectorManifest,
  DeltaPage,
  ScopeDescriptor,
} from '../contract.js';
import type { CanonicalDoc } from '../../corpus/types.js';
import { GithubClient, type GithubClientOptions } from './client.js';
import { authenticate } from './auth.js';
import { pullRepoIssuesAndPRs } from './pull-delta.js';
import type { GithubRepo } from './types.js';

export const GITHUB_MANIFEST: ConnectorManifest = {
  id: 'github',
  displayName: 'GitHub',
  authModes: ['pat'],
  domains: ['text', 'code'],
  aclModel: 'scope-scoped',
};

export interface GithubConnectorOptions extends GithubClientOptions {
  readonly client?: GithubClient;
}

export function createGithubConnector(options: GithubConnectorOptions = {}): Connector {
  const client = options.client ?? new GithubClient(options);
  return {
    manifest: GITHUB_MANIFEST,
    async authenticate(auth: AuthResult): Promise<AuthOutcome> {
      return authenticate(client, auth);
    },
    async listScopes(auth: AuthResult): Promise<readonly ScopeDescriptor[]> {
      const repos = await client.getJson<readonly GithubRepo[]>(auth, '/user/repos', {
        per_page: '100',
        sort: 'updated',
      });
      return repos.map(
        (r): ScopeDescriptor => ({
          id: r.full_name,
          displayName: r.full_name,
          type: 'github-repo',
          metadata: {
            defaultBranch: r.default_branch,
            description: r.description ?? '',
            url: r.html_url,
          },
        }),
      );
    },
    async pullDelta(
      auth: AuthResult,
      scope: ScopeDescriptor,
      cursor: string | null,
    ): Promise<DeltaPage> {
      return pullRepoIssuesAndPRs(client, auth, scope, cursor);
    },
    getDoc(_auth: AuthResult, _docId: string): Promise<CanonicalDoc | null> {
      // v1 retrieves docs from the local corpus; live re-fetch is reserved for a follow-up.
      return Promise.resolve(null);
    },
  };
}

export { authenticate, auditScopes } from './auth.js';
export { GithubClient } from './client.js';
export { encodeCursor, parseCursorSince, pullRepoIssuesAndPRs } from './pull-delta.js';
