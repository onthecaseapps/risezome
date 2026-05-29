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
import { pullRepoFiles } from './pull-files.js';
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
  readonly cacheDir?: string;
  readonly indexFiles?: boolean;
}

export function createGithubConnector(options: GithubConnectorOptions = {}): Connector {
  const client = options.client ?? new GithubClient(options);
  const indexFiles = options.indexFiles ?? true;
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
      const issuesPage = await pullRepoIssuesAndPRs(client, auth, scope, cursor);

      // Index repo files only on the first sync for a scope (cursor === null)
      // and only when a cacheDir is configured. Subsequent syncs leave the
      // cloned snapshot in place; a separate refresh action discards the
      // cache to force a re-clone.
      if (cursor !== null || !indexFiles || options.cacheDir === undefined) {
        return issuesPage;
      }

      const files = await pullRepoFiles(auth, scope, { cacheDir: options.cacheDir });
      return {
        docs: [...issuesPage.docs, ...files.docs],
        chunks: [...issuesPage.chunks, ...files.chunks],
        nextCursor: issuesPage.nextCursor,
      };
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
export { chunkMarkdown, type MarkdownChunk } from './chunk-md.js';
export { chunkCode, type CodeChunk } from './chunk-code.js';
export { walkRepoFiles, classifyFile, type WalkedFile } from './walk.js';
export { ensureClone, discardClone } from './clone.js';
export { pullRepoFiles, makeCacheDir, type RepoFilesResult } from './pull-files.js';
