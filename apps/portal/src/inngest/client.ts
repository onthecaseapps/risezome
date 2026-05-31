import { Inngest } from 'inngest';

/**
 * Event vocabulary. All event names are namespaced under `risezome/...` so
 * the cloud dashboard's event browser is easy to scan.
 *
 * Conventions:
 *   - Past-tense names for things that already happened (e.g. `source.created`).
 *   - Imperative names for explicit user-or-system requests
 *     (e.g. `source.index-requested`).
 *   - Payload always includes `orgId` so the function can scope DB writes
 *     and the dashboard can filter per-org.
 */
export interface SourceIndexRequestedEvent {
  name: 'risezome/source.index-requested';
  data: {
    orgId: string;
    sourceId: string;
    reason: 'install' | 'reindex' | 'webhook';
  };
}

/**
 * The Inngest client is a singleton per process. Production uses the
 * INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY env vars set by the Vercel-Inngest
 * integration. Local dev uses the Inngest dev CLI which discovers functions
 * at http://localhost:3000/api/inngest and needs no env vars — leaving the
 * keys unset is the correct dev posture (the SDK auto-detects dev mode).
 */
export const inngest = new Inngest({
  id: 'risezome-portal',
});
