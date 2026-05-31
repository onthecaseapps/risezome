-- U11b: RLS on realtime.messages scoped to `meeting:<orgId>:<meetingId>`
-- topics. Without this, supabase.channel(name, { private: true })
-- subscriptions would be rejected by Realtime's RLS gate.
--
-- Topic format owned by apps/bot-worker/src/db.ts -> channelName():
--   meeting:<orgId>:<meetingId>
--
-- We split on ':' and check membership of split_part(topic, ':', 2)
-- against the calling user's org_members rows. Auth required.

create policy "members read their org's meeting broadcasts"
  on realtime.messages
  for select
  to authenticated
  using (
    extension = 'broadcast'
    and topic like 'meeting:%'
    and split_part(topic, ':', 2)::uuid in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );
