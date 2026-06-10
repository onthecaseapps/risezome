import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';

/**
 * Daily retention sweeps — makes the system's stated/implied retention real.
 *
 *   1. permission_audit_log > 18 months: the audit UI explicitly promises
 *      "retained for 18 months"; nothing enforced it (unbounded growth +
 *      storage-limitation exposure for the actor/target PII in `detail`).
 *   2. meeting_gap_misses processed > 30 days: plaintext verbatim staging rows
 *      whose occurrences were long since assembled into gaps — they were
 *      stamped processed_at but never deleted.
 *   3. pending_installations past expires_at: abandoned OAuth/install state
 *      tokens were only deleted on redemption.
 *   4. org_invites past expires_at: same — expired invite tokens accumulated.
 *   5. notifications read > 90 days: read notifications were never pruned.
 *
 * Every delete is idempotent and bounded by a timestamp predicate; a retry
 * simply matches fewer rows. Service-role (RLS bypass) by design — these are
 * cross-org lifecycle sweeps.
 */

const AUDIT_RETENTION_MONTHS = 18;
const PROCESSED_MISS_RETENTION_DAYS = 30;
const READ_NOTIFICATION_RETENTION_DAYS = 90;

function isoMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

export const retentionSweepsCron = inngest.createFunction(
  {
    id: 'retention-sweeps',
    name: 'Retention sweeps (audit log, processed misses, expired tokens, read notifications)',
    retries: 2,
    triggers: [{ cron: '30 4 * * *' }],
  },
  async ({ step }) => {
    const service = createServiceRoleClient();

    const audit = await step.run('purge-audit-log', async () => {
      const { error, count } = await service
        .from('permission_audit_log')
        .delete({ count: 'exact' })
        .lt('created_at', isoMonthsAgo(AUDIT_RETENTION_MONTHS));
      if (error !== null) throw new Error(`audit purge failed: ${error.message}`);
      return count ?? 0;
    });

    const misses = await step.run('purge-processed-misses', async () => {
      const { error, count } = await service
        .from('meeting_gap_misses')
        .delete({ count: 'exact' })
        .not('processed_at', 'is', null)
        .lt('processed_at', isoDaysAgo(PROCESSED_MISS_RETENTION_DAYS));
      if (error !== null) throw new Error(`miss purge failed: ${error.message}`);
      return count ?? 0;
    });

    const pendingInstalls = await step.run('purge-expired-pending-installations', async () => {
      const { error, count } = await service
        .from('pending_installations')
        .delete({ count: 'exact' })
        .lt('expires_at', new Date().toISOString());
      if (error !== null) throw new Error(`pending-installations purge failed: ${error.message}`);
      return count ?? 0;
    });

    const invites = await step.run('purge-expired-invites', async () => {
      const { error, count } = await service
        .from('org_invites')
        .delete({ count: 'exact' })
        .lt('expires_at', new Date().toISOString());
      if (error !== null) throw new Error(`invite purge failed: ${error.message}`);
      return count ?? 0;
    });

    // Webhook-created github_installations skeletons that were never claimed
    // (org_id still NULL) past the claim window are abandoned (e.g. a direct-
    // from-GitHub install, or a user who closed the tab before the callback) —
    // and a lingering NULL skeleton is an adoption target (see install-callback
    // SECURITY note). Reap them so the attack surface doesn't accumulate.
    const skeletons = await step.run('purge-unclaimed-github-skeletons', async () => {
      const { error, count } = await service
        .from('github_installations')
        .delete({ count: 'exact' })
        .is('org_id', null)
        .lt('installed_at', isoMinutesAgo(60));
      if (error !== null) throw new Error(`github skeleton purge failed: ${error.message}`);
      return count ?? 0;
    });

    const notifications = await step.run('purge-read-notifications', async () => {
      const { error, count } = await service
        .from('notifications')
        .delete({ count: 'exact' })
        .not('read_at', 'is', null)
        .lt('read_at', isoDaysAgo(READ_NOTIFICATION_RETENTION_DAYS));
      if (error !== null) throw new Error(`notification purge failed: ${error.message}`);
      return count ?? 0;
    });

    return { audit, misses, pendingInstalls, invites, skeletons, notifications };
  },
);
