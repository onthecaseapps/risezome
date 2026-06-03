-- Narrow card writes to the service-role pin/dismiss actions (security U8 / S8).
--
-- The "participants pin meeting cards" UPDATE policy let any meeting participant
-- PATCH *any* column of a card via PostgREST — Postgres RLS cannot restrict
-- which columns an UPDATE touches, so the participant predicate allowed
-- rewriting title/snippet/body/url/score/retracted_at, not just `pinned`.
-- Pin/dismiss already route through org-scoped service-role actions
-- (pinCardAction / dismissCardAction in card-actions-server.ts), so the client
-- UPDATE policy is redundant and an exploit surface. Drop it; the
-- participant-scoped SELECT policy is unchanged.
--
-- The analogous "participants confirm/dismiss meeting gaps" UPDATE policy is
-- already gone: public.gaps was dropped (20260606020000_knowledge_gaps.sql), and
-- knowledge_gaps deliberately has no client UPDATE policy (writes go through
-- org-checked actions).

drop policy if exists "participants pin meeting cards" on public.cards;
