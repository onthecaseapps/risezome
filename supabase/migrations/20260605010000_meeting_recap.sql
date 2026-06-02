-- U7: whole-meeting AI recap, generated asynchronously when a meeting ends.
-- Stored on the meeting so the review page can render it (with a "generating…"
-- state while the Inngest function runs).
--
-- recap_status lifecycle: null (not requested) → generating → done | failed.
-- Additive + nullable; existing rows and readers are unaffected.

alter table public.meetings
  add column recap_text         text,
  add column recap_status       text
    check (recap_status in ('generating', 'done', 'failed')),
  add column recap_generated_at timestamptz;
