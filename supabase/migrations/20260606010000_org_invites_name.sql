-- Label each invite link with the intended recipient's name, so a manager can
-- tell which pending link maps to which teammate (link-based invites have no
-- email to identify them by). Optional — an unlabeled link still works.
--
-- Backfill existing rows to a placeholder so no pending invite reads blank.

alter table public.org_invites add column if not exists name text;

update public.org_invites set name = 'Jeremy' where name is null;
