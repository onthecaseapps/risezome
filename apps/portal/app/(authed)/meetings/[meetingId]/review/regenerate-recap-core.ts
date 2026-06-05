/**
 * Regenerate-recap core (U6). Pure orchestration, decoupled from the Next
 * 'use server' wrapper so it can be unit-tested with injected clients. The
 * 'use server' module (regenerate-recap-server.ts) resolves the real auth +
 * Supabase clients + inngest and calls this.
 *
 * Authorization rides on RLS: the participant-scoped SELECT on `meetings`
 * returns the row only for attendees ∪ super-admin, so a successful read IS the
 * access check (same gate the review page uses). The status write is
 * service-role + org-scoped (KTD5: recap writes stay service-role; there is no
 * client UPDATE policy on meetings).
 */

interface SelectResult {
  readonly data: { meeting_id: string } | null;
}

interface RlsClient {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): {
        eq(col: string, val: string): { maybeSingle(): Promise<SelectResult> };
      };
    };
  };
}

interface UpdateResult {
  readonly error: { message: string } | null;
}

interface ServiceClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(col: string, val: string): { eq(col: string, val: string): Promise<UpdateResult> };
    };
  };
}

export interface RegenerateRecapDeps {
  readonly orgId: string;
  /** RLS-scoped client — its SELECT is the participant/super-admin access check. */
  readonly rls: RlsClient;
  /** Service-role client — performs the org-scoped status write. */
  readonly service: ServiceClient;
  /** Emit the recap-requested event (injected inngest.send). */
  readonly send: (event: {
    name: 'risezome/meeting.recap-requested';
    data: { meetingId: string; orgId: string };
  }) => Promise<unknown>;
}

export type RegenerateRecapResult = { ok: true } | { ok: false; error: string };

export async function regenerateRecap(
  deps: RegenerateRecapDeps,
  meetingId: string,
): Promise<RegenerateRecapResult> {
  // Authorize via RLS: row visible ⇒ caller is an attendee or super-admin.
  const { data: meeting } = await deps.rls
    .from('meetings')
    .select('meeting_id')
    .eq('meeting_id', meetingId)
    .eq('org_id', deps.orgId)
    .maybeSingle();
  if (meeting === null) return { ok: false, error: 'not_authorized' };

  // Flip to generating (service-role; org-scoped defense-in-depth) BEFORE the
  // emit so the page reflects the in-flight state immediately. concurrency:1 per
  // meetingId on the function prevents a double-run if clicked twice.
  const { error } = await deps.service
    .from('meetings')
    .update({ recap_status: 'generating' })
    .eq('meeting_id', meetingId)
    .eq('org_id', deps.orgId);
  if (error !== null) return { ok: false, error: error.message };

  await deps.send({
    name: 'risezome/meeting.recap-requested',
    data: { meetingId, orgId: deps.orgId },
  });
  return { ok: true };
}
