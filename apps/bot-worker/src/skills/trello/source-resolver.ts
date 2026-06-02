import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Per-org Trello access, resolved at skill-call time from the meeting's orgId.
 *
 * Mirrors the Trello indexer's auth path (apps/portal/src/inngest/functions/
 * index-trello.ts): a board source carries a `connection_id`, and the read
 * token lives in `trello_connections` keyed by that id (service-role only). The
 * indexer resolves one board → its connection → token; here we resolve every
 * connected board for the org and the token behind them. The platform API key
 * (TRELLO_API_KEY) is held by the client, not here — exactly as the indexer
 * pairs `conn.token` with `requireTrelloApiKey()`.
 */

export interface TrelloBoardRef {
  readonly id: string;
  readonly name: string;
}

export interface TrelloAccess {
  /** Read-scoped Trello user token for this org's connection. */
  readonly token: string;
  readonly boards: readonly TrelloBoardRef[];
}

/** orgId → access, or null when the org has no Trello board connected. */
export type TrelloSourceResolver = (orgId: string) => Promise<TrelloAccess | null>;

interface SourceRow {
  readonly external_id: string | null;
  readonly display_name: string | null;
  readonly connection_id: string | null;
}

export function buildTrelloSourceResolver(deps: { db: SupabaseClient }): TrelloSourceResolver {
  return async (orgId: string): Promise<TrelloAccess | null> => {
    // The org's connected Trello boards carry both the board id (external_id)
    // and the connection that authorizes reading them (connection_id) — same
    // columns the indexer's load-source step reads.
    const { data: sourceData, error: sourceError } = await deps.db
      .from('sources')
      .select('external_id, display_name, connection_id')
      .eq('org_id', orgId)
      .eq('kind', 'trello')
      .neq('status', 'removed');
    if (sourceError !== null) {
      throw new Error(`sources lookup failed for org ${orgId}: ${sourceError.message}`);
    }

    const rows = (sourceData ?? []) as SourceRow[];
    const boards: TrelloBoardRef[] = [];
    const connectionIds = new Set<string>();
    for (const row of rows) {
      if (typeof row.external_id !== 'string' || row.external_id.length === 0) continue;
      if (typeof row.connection_id !== 'string' || row.connection_id.length === 0) continue;
      boards.push({ id: row.external_id, name: row.display_name ?? row.external_id });
      connectionIds.add(row.connection_id);
    }
    if (boards.length === 0) return null;

    // Resolve the read token via the board's connection (trello_connections is
    // unique per org, so the connected boards share one connection today). Fetch
    // the token by connection id — the indexer's exact join — rather than by org.
    const { data: connData, error: connError } = await deps.db
      .from('trello_connections')
      .select('token')
      .in('id', Array.from(connectionIds))
      .limit(1)
      .maybeSingle();
    if (connError !== null) {
      throw new Error(`trello_connections lookup failed for org ${orgId}: ${connError.message}`);
    }
    const token = (connData)?.token;
    if (token === undefined || token.length === 0) return null;

    return { token, boards };
  };
}
