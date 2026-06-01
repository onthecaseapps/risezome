import type { TrelloClient } from './client.js';
import type { TrelloSourceResolver } from './source-resolver.js';

/**
 * Context closed over by live-API Trello skills at registration time.
 *
 * Carries a shared HTTP client (holding the platform API key) plus a per-org
 * resolver: at skill-call time the skill calls `resolve(orgId)` to get the
 * meeting org's Trello token + connected boards. Multi-tenant — each customer's
 * Trello access comes from their own connection (the `trello_connections` +
 * `sources` rows), not a platform-wide token.
 */
export interface TrelloLiveContext {
  readonly client: TrelloClient;
  readonly resolve: TrelloSourceResolver;
}
