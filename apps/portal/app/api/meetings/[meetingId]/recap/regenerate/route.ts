import { NextResponse } from 'next/server';
import { requireAuthedUserWithOrg } from '../../../../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../../../../_lib/supabase-server';
import { inngest } from '../../../../../../src/inngest/client';
import { regenerateRecap } from '../../../../../(authed)/meetings/[meetingId]/review/regenerate-recap-core';

/**
 * Agent/programmatic path for regenerating a meeting recap — parity with the
 * review page's Regenerate button (regenerate-recap-server.ts). Both authorize
 * the same way: the participant-scoped RLS SELECT in the shared `regenerateRecap`
 * core (attendees ∪ super-admin), then re-fire the recap pipeline. Org is derived
 * from the session, never trusted from the client.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ meetingId: string }> },
): Promise<NextResponse> {
  const { meetingId } = await ctx.params;
  const { orgId } = await requireAuthedUserWithOrg();
  const rls = await createServerClient();
  const service = createServiceRoleClient();

  const result = await regenerateRecap(
    {
      orgId,
      rls: rls as unknown as Parameters<typeof regenerateRecap>[0]['rls'],
      service: service as unknown as Parameters<typeof regenerateRecap>[0]['service'],
      send: (event) => inngest.send(event),
    },
    meetingId,
  );

  if (!result.ok) {
    const status = result.error === 'not_authorized' ? 403 : 500;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
