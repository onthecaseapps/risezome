import { chunkFile } from '@risezome/engine/chunker';
import { inngest, type IndexMode } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { sanitizeStatusMessage } from '../lib/status-message';
import { AtlassianAuthError } from '../../../app/_lib/atlassian';
import { getValidAtlassianToken } from '../../../app/_lib/atlassian-token';
import {
  fetchJiraComments,
  searchJiraIssues,
  type AtlassianContext,
  type JiraIssue,
} from '../../../app/_lib/atlassian-client';
import { buildIssueDocText, jiraIssueDocId } from '../../../app/_lib/atlassian-doc';
import { runConnectorIndex, type PreparedDoc } from '../lib/connector-index';
import { optionalContextGenerator, optionalDocSummarizer } from '../lib/contextualizer';

const RECONNECT_MSG = 'Atlassian access was revoked or expired. Reconnect Atlassian to re-index.';

/**
 * Index a single Jira project's issues (+ comments). The shared connector
 * orchestrator handles reconcile (skip-unchanged, atomic re-embed, full
 * prune, counters); this file supplies the Jira specifics. The token is
 * resolved up front because both the issue fetch and per-issue comment
 * fetch need it.
 */
export const indexJiraFn = inngest.createFunction(
  {
    id: 'index-jira',
    name: 'Index a Jira project source',
    concurrency: [
      { key: 'event.data.sourceId', limit: 1 },
      { key: 'event.data.orgId', limit: 2 },
    ],
    retries: 3,
    triggers: [{ event: 'risezome/jira.index-requested' }],
    // Safety net: when all retries are exhausted, flip the source to
    // `errored` instead of leaving it wedged at `indexing` (which grays
    // out the Reindex button forever). Mirrors index-repo's onFailure.
    onFailure: async ({ event, error }) => {
      const original = (event as unknown as {
        data: { event: { data: { sourceId: string; orgId?: string } } };
      }).data.event;
      const sourceId = original?.data?.sourceId;
      const orgId = original?.data?.orgId;
      if (typeof sourceId !== 'string' || sourceId.length === 0) return;
      const message = error instanceof Error ? error.message : String(error);
      if (typeof orgId === 'string' && orgId.length > 0) {
        await createServiceRoleClient()
          .from('sources')
          .update({ status: 'errored', status_message: sanitizeStatusMessage(message) })
          .eq('id', sourceId)
          .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
      } else {
        // service-role-cross-org: onFailure for an event that carried no orgId
        // (older queued events) — the sources PK (id) is globally unique, so this
        // targets exactly one row; no org_id is available to scope by.
        await createServiceRoleClient()
          .from('sources')
          .update({ status: 'errored', status_message: sanitizeStatusMessage(message) })
          .eq('id', sourceId);
      }
    },
  },
  async ({ event, step }) => {
    const { orgId, sourceId, mode } = (event as unknown as {
      data: { orgId: string; sourceId: string; mode?: IndexMode };
    }).data;

    const ctx = await step.run('load-source', async () => {
      const service = createServiceRoleClient();
      const { data: source, error } = await service
        .from('sources')
        .select('id, kind, external_id')
        .eq('id', sourceId)
        .eq('org_id', orgId)
        .single();
      if (error !== null || source === null || source.kind !== 'jira' || source.external_id === null) {
        throw new Error(`source ${sourceId} is not an indexable Jira project`);
      }
      await service
        .from('sources')
        .update({ status: 'indexing', status_message: null, indexed_files: 0, total_files: null })
        .eq('id', sourceId)
        .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
      return { projectKey: source.external_id as string };
    });

    // Resolve the Atlassian token outside any memoized step so the live bearer
    // token never lands in Inngest run state — Inngest persists step return
    // values as run state, which would put the secret at rest outside our
    // DB/redaction boundary (same no-persist pattern as index-trello).
    let token;
    try {
      token = await getValidAtlassianToken(orgId, createServiceRoleClient());
    } catch (err) {
      if (err instanceof AtlassianAuthError) {
        await markErrored(step, orgId, sourceId);
        return { sourceId, issues: 0, chunks: 0, error: 'atlassian_auth' };
      }
      throw err;
    }

    const client: AtlassianContext = { accessToken: token.accessToken, cloudId: token.cloudId };
    const cloudId = token.cloudId;
    const siteUrl = token.siteUrl ?? '';

    const result = await runConnectorIndex<JiraIssue>({
      step,
      orgId,
      sourceId,
      mode,
      source: 'jira',
      docType: 'issue',
      provenance: 'trusted',
      reconnectMessage: RECONNECT_MSG,
      contextGenerator: optionalContextGenerator(),
      docSummarizer: optionalDocSummarizer(),
      isAuthError: (err) => err instanceof AtlassianAuthError,
      fetchEntities: () => searchJiraIssues(ctx.projectKey, client),
      prepare: async (issue): Promise<PreparedDoc | null> => {
        const comments = await fetchJiraComments(issue.key, client);
        const text = buildIssueDocText(issue, comments);
        const chunks = chunkFile('jira-issue.md', text);
        if (chunks.length === 0) return null;
        return {
          docId: jiraIssueDocId(orgId, cloudId, issue.key),
          title: issue.summary,
          url: siteUrl.length > 0 ? `${siteUrl}/browse/${issue.key}` : null,
          // The issue's real fields.updated, not wall-clock "now" — recency
          // signals should reflect actual issue activity.
          updatedAt: issue.updated ?? new Date().toISOString(),
          docText: text,
          chunks: chunks.map((c) => ({ text: c.text, domain: c.domain })),
        };
      },
    });

    return { sourceId, issues: result.items, chunks: result.chunks, ...(result.error !== undefined && { error: result.error }) };
  },
);

async function markErrored(
  step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> },
  orgId: string,
  sourceId: string,
): Promise<void> {
  await step.run('mark-token-errored', async () => {
    await createServiceRoleClient()
      .from('sources')
      .update({ status: 'errored', status_message: RECONNECT_MSG })
      .eq('id', sourceId)
      .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
  });
}
