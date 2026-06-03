-- Dev-only seed. `supabase db reset` runs this AFTER migrations against the
-- LOCAL stack. Production / `supabase db push` never run it. Keep it minimal —
-- just enough that a fresh local stack is immediately usable.
--
-- It creates one confirmed email/password user, one org, and a manager
-- membership, so you can sign in at http://localhost:3000 with:
--
--     email:    dev@risezome.test
--     password: devpassword
--
-- Email/password (not Google OAuth) so local sign-in needs no OAuth setup.
-- Idempotent: re-running `supabase db reset` is stable.
--
-- NOTE: the auth.users / auth.identities shape is owned by Supabase Auth and
-- can shift across CLI versions. If a reset errors here, update these inserts
-- to match the installed CLI's schema.

-- Fixed IDs so re-seeding binds to the same rows.
-- user: …0001   org: …00a1

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
)
values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated',
  'dev@risezome.test',
  crypt('devpassword', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Dev User"}'::jsonb
)
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider,
  created_at, updated_at, last_sign_in_at
)
values (
  gen_random_uuid(),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'sub', '00000000-0000-4000-8000-000000000001',
    'email', 'dev@risezome.test',
    'email_verified', true
  ),
  'email',
  now(), now(), now()
)
on conflict do nothing;

insert into public.orgs (id, name)
values ('00000000-0000-4000-8000-0000000000a1', 'Dev Org')
on conflict (id) do nothing;

insert into public.org_members (org_id, user_id, role)
values (
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-000000000001',
  'manager'
)
on conflict (org_id, user_id) do nothing;
