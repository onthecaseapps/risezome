-- Encrypt meeting transcript text at rest (security F2, follow-up to U9 / S9).
--
-- meeting_events.payload is jsonb shared by all event types and is QUERIED via
-- payload->>'speaker' (capture_card_stats), so it can't be encrypted whole.
-- Instead we move only the sensitive transcript words — payload.text — out into
-- an encrypted column (pgcrypto AES-256, KTD1). speaker / timing / utteranceId
-- stay in payload (plaintext), so capture_card_stats is unchanged. The
-- live-broadcast path still sends plaintext text to authorized participants
-- (in memory, not stored); only the persisted copy is encrypted.

alter table public.meeting_events add column transcript_text_enc bytea;

-- Pre-launch: strip plaintext transcript text from existing rows (not carried
-- forward — old dev transcripts lose their text rather than persisting plaintext).
update public.meeting_events
  set payload = payload - 'text'
  where type = 'transcript.data' and payload ? 'text';

-- Batch transcript reader: returns a meeting's transcript events with the text
-- decrypted server-side in one round-trip (avoids N decrypt RPCs for a long
-- meeting). SECURITY INVOKER so the caller's RLS on meeting_events still gates
-- which rows they can read; the key is supplied by the (server-side) caller.
create or replace function public.transcript_with_text(
  p_meeting_id uuid,
  p_org_id     uuid,
  p_key        text
)
returns table (event_id bigint, payload jsonb, created_at timestamptz, text text)
language sql
stable
security invoker
set search_path = public
as $$
  select
    e.event_id,
    e.payload,
    e.created_at,
    case when e.transcript_text_enc is not null
      then extensions.pgp_sym_decrypt(e.transcript_text_enc, p_key)
      else null end as text
  from public.meeting_events e
  where e.meeting_id = p_meeting_id
    and e.org_id = p_org_id
    and e.type = 'transcript.data'
  order by e.event_id asc;
$$;

grant execute on function public.transcript_with_text(uuid, uuid, text) to authenticated, service_role;
