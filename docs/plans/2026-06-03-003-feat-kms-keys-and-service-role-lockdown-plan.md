---
title: "feat: Per-tenant KMS key custody + service-role least-privilege"
status: active
date: 2026-06-03
type: feat
threat_model: app/key compromise or insider
---

# Per-tenant KMS key custody + service-role least-privilege

## Summary

Two security work streams hardening the Risezome multi-tenant SaaS (`apps/portal`
Next.js RSC, `apps/bot-worker` Fastify on Fly.io, Supabase Postgres + RLS) against
the **app/key compromise or insider** threat model.

1. **Per-tenant key custody via AWS KMS.** Replace the single global
   `USER_TOKEN_ENCRYPTION_KEY` (pgcrypto, key passed into SQL) with **per-org
   envelope encryption**: a per-org KMS Customer Master Key (CMK) wraps the data
   keys, the actual AES-256-GCM encrypt/decrypt happens **app-side via the AWS
   Encryption SDK (`node:crypto` under the hood)**, and `encryption-context = {org_id}`
   is enforced by KMS on every decrypt. The database (and a Supabase operator /
   DB insider) only ever sees opaque ciphertext — never a key, never plaintext.
   One org's compromised/leaked key caps exposure to that org, and key custody
   lives outside the app process, which is the only thing that meaningfully
   constrains an attacker who owns the app process (bounded by IAM/key policy)
   while adding a tamper-evident decrypt audit log and instant per-org revocation.

2. **Service-role least-privilege.** Shrink the blast radius of the Supabase
   service-role (RLS-bypass) key. Foundation: add missing defense-in-depth
   `org_id` filters, land the cross-org query-enforcement guard that `db.ts`
   already promises, and drop unscoped client write policies. Structural: migrate
   the server-side **read** paths that merely act on behalf of the signed-in user
   onto the existing authenticated (user-JWT) client so RLS enforces tenant
   isolation, leaving service-role for webhooks, background jobs, the bot-worker,
   and admin lookups only. **Mutations stay on hardened service-role server
   actions** — RLS-ifying them would require the unscoped client-write-policy
   antipattern recorded in `docs/solutions/` and user memory.

Security docs (`SECURITY.md`, the content-encryption solution doc, the key-rotation
runbook, the sub-processors doc) are updated as part of the work.

**Honesty note carried from research:** in-app per-tenant schemes (HKDF-derived or
an in-env-KEK envelope) do **not** change posture versus today's single key under
the insider/app-compromise threat, because the unlocking secret still lives in the
process. This plan uses external KMS specifically because it is the only option
that does. The remaining residual — the searchable corpus (`doc_chunks.text` +
embeddings) — is out of scope and stays disk-encryption-only by design.

---

## Problem Frame

The prior security remediation (plan `2026-06-03-002`, 16 units + F1/F2) brought
every high-sensitivity column under pgcrypto column encryption with a single
symmetric key held in app env (`USER_TOKEN_ENCRYPTION_KEY`), shared by portal and
bot-worker. That closed the **DB-dump / backup / replica** threat: a stolen disk
or DB dump yields only ciphertext.

It does **not** close the threat the user has now named — **app/key compromise or
insider**:

- A leaked service-role key or a compromised app endpoint reaches **all tenants,
  all tables** (RLS bypassed), and holds the one encryption key, so it decrypts
  every org's secrets.
- A Supabase operator / DB insider watching the Postgres process sees both the key
  (passed as a `pgp_sym_decrypt(col, key)` argument) **and** the decrypted
  plaintext, because pgcrypto runs crypto server-side.

The two streams attack the two halves: per-tenant KMS custody caps the encryption
blast radius to one org and removes keys+plaintext from the DB's view; the
service-role work caps what a leaked key or compromised endpoint can reach.

---

## Requirements

- **R1** — Each org's column-encrypted secrets are encrypted under a key whose
  custody is external to the app process (KMS), such that compromise of one org's
  key does not expose other orgs.
- **R2** — The database never receives encryption keys or plaintext for the
  encrypted columns; ciphertext is opaque app-defined envelope bytes.
- **R3** — `encryption-context = {org_id}` is bound at encrypt and enforced at
  decrypt, so a forged or mismatched org cannot decrypt another org's ciphertext.
- **R4** — Per-org key rotation and instant per-org revocation are operationally
  supported and documented; existing rotation machinery is superseded cleanly.
- **R5** — Existing encrypted data is migrated to the new scheme without data loss
  (recaps/transcripts/syntheses cannot be regenerated).
- **R6** — Every service-role query is `org_id`-scoped (defense-in-depth), enforced
  by an automated guard so it cannot regress.
- **R7** — Server-side read paths acting on behalf of the signed-in user run under
  RLS via the authenticated client; service-role is reserved for webhooks, jobs,
  the bot-worker, and admin lookups.
- **R8** — No org-scoped table carries a client-facing write policy lacking column
  scoping (the `knowledge_gaps` antipattern).
- **R9** — Each fix is pinned by a regression test (RLS-denial for authz, decrypt +
  per-org-isolation for crypto), per the eval-regression-coverage convention.
- **R10** — The bot-worker transcript hot path does not incur a KMS network call
  per utterance (data-key caching).

---

## Key Technical Decisions

### KTD1 — AWS KMS envelope via the AWS Encryption SDK, crypto app-side
Use the **AWS Encryption SDK for JavaScript** (`@aws-crypto/client-node`) with a
**KMS keyring** and a **caching cryptographic materials manager (CMM)**. The SDK
generates/wraps data keys, performs AES-256-GCM in `node:crypto`, and emits a
self-describing ciphertext message that embeds the wrapped data key — so the DB
stores opaque bytes and we do not hand-manage IVs, tags, or DEK storage. Satisfies
"industry-standard libraries, never roll our own" (KTD inherited from plan 002).
Rationale: only out-of-process key custody touches the insider/app-compromise
threat; app-side AES keeps keys + plaintext off the DB server, which is the bigger
honest win and directly addresses the DB-insider half.

### KTD2 — Per-org CMK (not single CMK + encryption-context alone)
Provision **one KMS CMK per org**, addressed by a deterministic alias
(`alias/risezome-org-<org_id>`), lazily created on org provisioning. Rationale:
the research is explicit that a single CMK + `encryption-context` does **not** cap
an app-compromised attacker to one org — they can request decrypts for any org_id
they supply. Per-org CMK delivers the per-org capping the user asked for, plus
per-org CloudTrail and per-org instant revocation (disable the key). Cost ~$1/CMK/mo
and a 100k-keys/region ceiling are acceptable for a B2B SaaS where orgs are paying
customers; data-key caching keeps KMS request volume low. **Encryption-context =
`{org_id}` is still bound** as defense-in-depth on top of the per-org CMK. Fallback
if org count ever approaches the ceiling: single CMK + per-org DEK + enc-context
(documented, not implemented).

### KTD3 — Columns hold an app-defined envelope; pgcrypto SQL crypto is retired
The `*_enc` columns stay `bytea` but now hold the Encryption SDK message format
instead of pgcrypto OpenPGP packets. The SQL helpers
`public.encrypt_refresh_token` / `public.decrypt_refresh_token`, the
`transcript_with_text` RPC, and `rewrap_encrypted_secrets` are retired after
migration. Rationale: passing a KMS-unwrapped DEK into `pgp_sym_decrypt` would put
a plaintext key on the DB server and at risk in statement logs (documented pgcrypto
pitfall) — defeating the point. Crypto moves fully app-side.

### KTD4 — User-level Google token keyed by the user's org-of-record
`user_google_tokens.refresh_token_enc` and the Google OAuth callback have no org in
scope today and are per-user. Decision: key them under the user's **org-of-record**
(oldest membership, mirroring `requireAuthedUserWithOrg`'s fallback) and add a
`key_org_id` column so decrypt resolves the right CMK. Documented caveat: a user in
multiple orgs has their Google token encrypted under one org's key; acceptable
since the token is the user's and reachable in any of their orgs via the resolver.

### KTD5 — Reads move to RLS; mutations stay hardened service-role
The authenticated, RLS-respecting client **already exists**
(`apps/portal/app/_lib/supabase-server.ts` `createServerClient`, cookie-bound
publishable key → runs as `authenticated`). Stream 1 Option 2 = switch category-(b)
**read** paths to it. **Mutations stay on service-role server actions** with
app-code permission checks + `org_id` scoping, because moving them to RLS would
require client-facing write policies, which — unless column-scoped via triggers or
per-column GRANTs — are the exact exploit surface recorded in
`docs/solutions/` and `rls-no-client-update-when-service-role-writes` memory. This
is the correct reading of "tighten the rest," not blanket RLS-ification.

### KTD6 — Shared crypto module preserves the portal↔bot-worker key-equality invariant
Both surfaces must encrypt/decrypt identically (runbook invariant). The envelope
crypto lives in **one shared module** consumed by both `apps/portal` and
`apps/bot-worker` (new `packages/crypto`, or an `@risezome/engine` submodule —
bot-worker already imports `@risezome/engine`). No second implementation.

### KTD7 — One-time app-side re-encryption migration (not a SQL rewrap)
Because the new format is app-side, the global→per-org migration is an **app-side
job** (Inngest function / script): per org ensure a CMK exists, then per encrypted
row `decrypt-old(pgcrypto, global key)` → `encryptForOrg(org_id, …)` → write + bump
version. Idempotent and resumable via the per-row `*_version` columns. Pre-launch
data volume is low. Old pgcrypto helpers remain available until the migration is
verified, then are dropped (KTD3).

### KTD8 — Defense-in-depth `org_id` scoping is mandatory regardless of stream
The three PK-only service-role `UPDATE`s and the missing cross-org guard are fixed
independent of the RLS migration; they harden the paths that genuinely keep
service-role.

---

## High-Level Technical Design

### Envelope encrypt/decrypt flow (per org)

```mermaid
sequenceDiagram
    participant App as App (portal / bot-worker)
    participant Cache as In-proc caching CMM
    participant KMS as AWS KMS (per-org CMK)
    participant DB as Supabase (bytea column)

    Note over App: encryptForOrg(orgId, plaintext)
    App->>Cache: data key for orgId?
    alt cache miss
        Cache->>KMS: GenerateDataKey(alias/risezome-org-<orgId>,<br/>enc-context={org_id})
        KMS-->>Cache: plaintext DEK + wrapped DEK
    end
    Cache-->>App: DEK (plaintext, cached, TTL-bounded)
    App->>App: AES-256-GCM encrypt (node:crypto)
    App->>DB: store envelope message (bytea)<br/>[wrapped DEK + iv + tag + ciphertext]

    Note over App: decryptForOrg(orgId, bytea)
    App->>Cache: decrypt materials for this message?
    alt cache miss
        Cache->>KMS: Decrypt(wrapped DEK,<br/>enc-context={org_id})
        KMS-->>Cache: plaintext DEK (only if enc-context matches)
    end
    Cache-->>App: DEK
    App->>App: AES-256-GCM decrypt (node:crypto)
    Note over DB,KMS: DB never sees DEK or plaintext;<br/>KMS never sees plaintext
```

### Client-selection decision (Stream 1)

| Call site shape | Org derived from | Client | Why |
| --- | --- | --- | --- |
| Webhook (Recall, GitHub, OAuth callback) | trusted DB lookup / signed state | service-role | no user JWT in request |
| Inngest job / cron / bot-worker | trusted event payload | service-role | background, no user session |
| Server **read** on behalf of signed-in user | JWT/cookie | **authenticated (`createServerClient`)** | RLS enforces tenant isolation |
| Server **mutation** by signed-in user | JWT/cookie | service-role + app check + `org_id` | avoids unscoped client write policy (KTD5) |
| Admin `auth.users` display-name lookup | manager-gated | service-role (admin API) | RLS cannot serve admin auth API |

---

## Implementation Units

Two streams. Stream 1 (U1–U6) and Stream 2 (U7–U13) are independent and may proceed
in parallel; U14 (docs) lands last. **Prerequisite:** F1/F2 (synthesis + transcript
encryption, branch `fix/encrypt-transcripts-syntheses`, commits `c58637a`/`6146bd2`)
must be merged to the base branch first — this plan reworks those columns.

### Stream 1 — Service-role least-privilege

### U1. Defense-in-depth `org_id` on PK-only service-role UPDATEs
- **Goal:** Close the three service-role `UPDATE`s that match by primary key only,
  so a wrong/forged id cannot write across orgs.
- **Requirements:** R6, R9
- **Dependencies:** none
- **Files:**
  - `apps/bot-worker/src/db.ts` (`markRecordingIfFirst` — add `.eq('org_id', args.orgId)`)
  - `apps/bot-worker/src/retrieval.ts` (synthesis `accumulated_text_enc` UPDATE ~:1085 — add org filter)
  - `apps/portal/app/api/recall/webhook/route.ts` (meeting status UPDATE — add org filter once org resolved)
  - `apps/bot-worker/test/db.test.ts` (new or existing), `apps/portal/test/rls/meeting-participants.test.ts`
- **Approach:** Thread `org_id` (already in scope at each site) into the `.update().eq()`
  chain. Pure additive scoping; no behavior change for correct callers.
- **Patterns to follow:** the `meeting_events` insert in `db.ts:87` already filters `org_id`.
- **Test scenarios:**
  - Happy path: update with correct `(id, org_id)` succeeds.
  - Cross-org: update with correct id but a different `org_id` affects **0 rows**.
  - Covers R6 for these three sites.
- **Verification:** each UPDATE has an `org_id` predicate; cross-org test asserts 0 rows updated.

### U2. Cross-org query-enforcement guard (CI)
- **Goal:** Land the automated guard `db.ts` already promises — flag any service-role
  `.from(<org-scoped table>)` query missing an `org_id` scope so it cannot regress.
- **Requirements:** R6, R9
- **Dependencies:** U1 (so the guard passes on a clean tree)
- **Files:**
  - `scripts/lint/check-service-role-org-scope.mjs` (new — AST or structured grep over `apps/*/src` and `apps/portal/app`)
  - `package.json` (wire into `lint`/CI script)
  - `scripts/lint/__tests__/check-service-role-org-scope.test.ts` (new)
  - update the `db.ts:5-11` comment to point at the now-real guard
- **Approach:** Enumerate org-scoped tables from the schema; for each service-role
  client query against one, require a sibling `.eq('org_id', …)`/`.in('org_id', …)`
  or an allowlist annotation comment (`// service-role-cross-org: <reason>`) for the
  genuinely cross-org jobs (e.g. reconcile sweeps). Fail CI on an unannotated miss.
- **Execution note:** test-first — write fixtures (a scoped query passes, an unscoped
  one fails, an annotated one passes) before the checker.
- **Test scenarios:**
  - Scoped query → pass. Unscoped query on an org-scoped table → fail with file:line.
  - Annotated cross-org query → pass. Query on a non-org table → ignored.
- **Verification:** CI fails on a deliberately unscoped fixture; passes on the real tree.

### U3. Drop unscoped client write policies; assert RLS-denial
- **Goal:** Ensure no org-scoped table has a client-facing write policy lacking column
  scoping (the `knowledge_gaps` antipattern).
- **Requirements:** R8, R9
- **Dependencies:** none
- **Files:**
  - `supabase/migrations/<ts>_drop_unscoped_client_write_policies.sql` (new, if any remain after plan-002 U8)
  - `apps/portal/test/rls/*.test.ts` (RLS-denial assertions)
- **Approach:** Audit `pg_policies` for `cmd in ('INSERT','UPDATE')` with `roles = {authenticated}`
  and no column scoping; drop each, confirm the corresponding mutation already flows
  through a service-role server action. Where a genuine client write path exists,
  scope it with a `BEFORE UPDATE` trigger or per-column GRANT instead of dropping.
- **Test scenarios:**
  - Direct PostgREST `PATCH`/`POST` as an authenticated member on each affected table → **rejected**.
  - The service-role server action for the same mutation still succeeds.
  - Covers R8 (mirror the `knowledge_gaps` regression test shape).
- **Verification:** `pg_policies` shows no unscoped authenticated write policy; RLS-denial tests pass.

### U4. Migrate live-meeting **read** paths to the authenticated client
- **Goal:** Move the live/review meeting data **reads** off service-role onto
  `createServerClient` so RLS enforces tenant isolation.
- **Requirements:** R7, R9
- **Dependencies:** none (the authenticated client already exists)
- **Files:**
  - `apps/portal/app/(authed)/meetings/[meetingId]/live/page.tsx`
  - `apps/portal/app/(authed)/meetings/[meetingId]/review/page.tsx`
  - `apps/portal/app/(authed)/meetings/[meetingId]/live/_meetings-lookup.ts` / related read helpers
  - `apps/portal/test/rls/meeting-participants.test.ts`
- **Approach:** Replace `createServiceRoleClient()` reads with `createServerClient()`
  where the data is the signed-in user's own org. Confirm SELECT RLS policies cover
  cards, syntheses, meeting_events for org members; add column-scoped SELECT policies
  only where missing. **Mutations (card/synthesis/end actions) are NOT migrated** —
  they stay service-role per KTD5.
- **Test scenarios:**
  - Member of the meeting's org reads live data via authenticated client → succeeds.
  - Member of another org reads the same meeting → **0 rows** (RLS).
  - Encrypted columns still decrypt correctly post-migration (integration with Stream 2 readers).
- **Verification:** live/review pages render for in-org members and deny out-of-org; reads no longer use service-role.

### U5. Migrate members / sources / gaps **read** paths to the authenticated client
- **Goal:** Same migration for the remaining category-(b) read paths.
- **Requirements:** R7, R9
- **Dependencies:** none
- **Files:**
  - `apps/portal/app/(authed)/members/page.tsx`, `apps/portal/app/(authed)/sources/page.tsx`,
    `apps/portal/app/(authed)/gaps/page.tsx`, `apps/portal/app/(authed)/upcoming/_meetings-lookup.ts`
  - corresponding `apps/portal/test/rls/*.test.ts`
- **Approach:** Switch reads to `createServerClient`. **Exceptions that stay service-role
  and must be justified inline:** admin `auth.users` display-name resolution
  (`member-actions.ts` admin API), and any read of teammate-owned rows that current
  RLS does not expose — for those, either add a column-scoped org-member SELECT
  policy (preferred, so the read can move to RLS) or annotate why service-role
  remains. Document each decision in the U14 inventory.
- **Test scenarios:**
  - In-org member reads members/sources/gaps via authenticated client → succeeds.
  - Out-of-org user → denied by RLS.
  - Admin display-name path still resolves names (kept on admin API).
- **Verification:** read paths use the authenticated client except the documented admin/teammate exceptions.

### U6. Service-role inventory (classification artifact)
- **Goal:** Produce the durable enumeration of every service-role site with its
  classification (genuine-bypass vs migrated-to-RLS vs kept-with-reason).
- **Requirements:** R7
- **Dependencies:** U4, U5
- **Files:** `docs/security/service-role-inventory.md` (new); linked from `SECURITY.md`
- **Approach:** Table of file:line → reads/writes → org derivation → client → rationale,
  seeded from the repo research map. This is the audit deliverable.
- **Test expectation:** none — documentation artifact.
- **Verification:** every service-role call site in the codebase appears with a classification.

### Stream 2 — Per-tenant KMS envelope encryption

### U7. Shared envelope-crypto module (AWS Encryption SDK + KMS keyring + caching CMM)
- **Goal:** One module exposing `encryptForOrg(orgId, plaintext): Promise<Buffer>` and
  `decryptForOrg(orgId, bytea): Promise<string>`, used by both apps.
- **Requirements:** R1, R2, R3, R6, R10
- **Dependencies:** none
- **Files:**
  - `packages/crypto/src/envelope.ts` (new; or `packages/engine/src/crypto/envelope.ts`)
  - `packages/crypto/package.json`, tsconfig, workspace wiring
  - `packages/crypto/test/envelope.test.ts` (new)
  - `apps/portal/.env.example`, `apps/bot-worker/.env.example` (AWS region, creds, `KMS_ALIAS_PREFIX`)
- **Approach:** Build a `KmsKeyringNode` targeting the per-org alias
  (`alias/${KMS_ALIAS_PREFIX}-org-<orgId>`), wrap a `getCachingMaterialsManager`
  with a `NodeCachingMaterialsManager` (bounded entries + max-age + max-bytes/messages
  per data key) so the transcript hot path reuses data keys (R10). Bind
  `encryptionContext = { org_id: orgId }` on encrypt; on decrypt, **verify** the
  returned context contains the expected `org_id` (the SDK enforces, but assert
  defensively). Return the SDK message bytes for storage.
- **Execution note:** test-first on the crypto contract.
- **Test scenarios:**
  - Round-trip: `decryptForOrg(org, encryptForOrg(org, s)) === s`.
  - Cross-org: decrypting org A's ciphertext with `decryptForOrg(orgB, …)` **throws** (enc-context mismatch).
  - Ciphertext contains no plaintext substring; output is non-deterministic across calls.
  - Cache: N encrypts for one org within TTL trigger a bounded number of KMS GenerateDataKey calls (assert via mocked KMS).
  - Error: KMS unreachable → throws a typed error (callers decide degradation).
- **Verification:** all crypto tests pass against a mocked KMS; an integration smoke test against a real test CMK round-trips.

### U8. Per-org CMK provisioning + key-reference schema
- **Goal:** Provision a CMK per org and track it; add the columns the per-org scheme
  needs on tables that lack them.
- **Requirements:** R1, R3, R4, R5
- **Dependencies:** U7
- **Files:**
  - `supabase/migrations/<ts>_org_encryption_keys.sql` (new: `org_encryption_keys(org_id uuid pk references orgs(id), kms_key_arn text, kms_alias text, status text default 'active', created_at timestamptz)`, RLS enabled, **no client policy** — service-role only)
  - `supabase/migrations/<ts>_add_key_refs_to_encrypted_tables.sql` (new: `user_google_tokens.key_org_id uuid`; `trello_connections.token_version int`; `meeting_events.transcript_key_version int` — the two tables missing version columns)
  - `apps/portal/src/inngest/functions/provision-org-key.ts` (new) **or** hook into org-creation path
  - shared resolver `getOrgKeyRef(orgId)` in `packages/crypto`
  - `apps/portal/test/rls/org-encryption-keys.test.ts` (new)
- **Approach:** On org creation, create a KMS key + alias (`alias/${prefix}-org-<id>`)
  and upsert `org_encryption_keys`; make it idempotent (alias is deterministic) so the
  migration (U11) can ensure-create lazily for existing orgs. `getOrgKeyRef` resolves
  alias from org_id (deterministic, with the table as the provisioning/revocation
  record).
- **Test scenarios:**
  - New org → CMK alias created, `org_encryption_keys` row written, status `active`.
  - Idempotent: re-running provisioning for an existing org does not create a second key.
  - RLS: a member cannot SELECT `org_encryption_keys` (service-role only).
  - `key_org_id` / version columns exist and default sanely.
- **Verification:** provisioning is idempotent; secret table is service-role-only; new columns present.

### U9. Rewire encrypt call sites to `encryptForOrg`
- **Goal:** Every encrypt path uses the per-org envelope module.
- **Requirements:** R1, R2, R3, R4 (KTD4)
- **Dependencies:** U7, U8
- **Files (encrypt sites from research):**
  - `apps/portal/app/api/auth/callback/route.ts` (Google refresh — key by org-of-record, set `key_org_id`)
  - `apps/portal/app/api/atlassian/callback/route.ts`, `apps/portal/app/_lib/atlassian-token.ts` (rotation)
  - `apps/portal/app/api/trello/connect/route.ts`
  - `apps/portal/src/inngest/functions/generate-meeting-recap.ts`
  - `apps/bot-worker/src/db.ts` (`persistAndBroadcast` transcript text — hot path, relies on cache)
  - `apps/bot-worker/src/retrieval.ts` (synthesis `accumulated_text_enc`)
  - retire `requireTokenKey()` usage at these sites
  - tests: `apps/portal/test/auth/callback.test.ts`, RLS tests seeding via the new module
- **Approach:** Replace `encryptToken(db, text)` / pgcrypto RPC calls with
  `encryptForOrg(orgId, text)`. For the Google callback, resolve org-of-record
  (oldest membership) and persist `key_org_id`. Bump the row's `*_version`.
- **Test scenarios:**
  - Each connector/content write stores ciphertext that `decryptForOrg(org, …)` recovers.
  - Google token: encrypted under org-of-record; `key_org_id` set; multi-org user keyed by oldest membership.
  - Bot-worker transcript: 100 sequential utterances for one org issue a bounded KMS call count (cache).
- **Verification:** no encrypt site references `requireTokenKey`/pgcrypto encrypt; round-trips succeed.

### U10. Rewire decrypt call sites; replace `transcript_with_text` RPC
- **Goal:** Every decrypt path uses `decryptForOrg`; the SQL bulk-decrypt RPC is
  replaced by app-side batch decrypt.
- **Requirements:** R2, R3
- **Dependencies:** U7, U8
- **Files (decrypt sites from research):**
  - `apps/portal/app/_lib/google-token.ts` (resolve `key_org_id`)
  - `apps/portal/app/_lib/atlassian-token.ts`
  - `apps/portal/src/inngest/functions/index-trello.ts`, `apps/bot-worker/src/skills/trello/source-resolver.ts`
  - `apps/portal/app/(authed)/meetings/[meetingId]/review/page.tsx`, `.../live/page.tsx`
  - `apps/portal/app/_lib/token-crypto.ts` (`transcriptWithText` → app-side batch decrypt over rows)
  - `apps/portal/src/inngest/lib/knowledge-gaps.ts` (`backfillMissesForMeeting` transcript reader)
  - tests: `apps/portal/test/rls/meeting-participants.test.ts`
- **Approach:** Replace `decryptToken`/`transcriptWithText` RPC with `decryptForOrg`.
  For transcripts, fetch the `transcript_text_enc` rows (RLS-scoped) then
  `decryptForOrg` each in-process (data-key cache makes this one effective KMS unwrap
  per org). Google token decrypt resolves `key_org_id` first.
- **Test scenarios:**
  - Recap, synthesis, transcript, and each connector token decrypt correctly post-rewire.
  - A transcript belonging to org A cannot be decrypted under org B's context.
  - Batch transcript decrypt for a long meeting issues a bounded KMS call count.
- **Verification:** `transcript_with_text` RPC no longer called; all readers go through `decryptForOrg`.

### U11. One-time re-encryption migration (global pgcrypto → per-org envelope)
- **Goal:** Migrate all existing ciphertext to the new scheme without data loss.
- **Requirements:** R5
- **Dependencies:** U7, U8, U9, U10
- **Files:**
  - `apps/portal/src/inngest/functions/migrate-encryption-to-kms.ts` (new — batched, resumable)
  - `docs/runbooks/encryption-kms-migration.md` (new)
  - migration verification queries
- **Approach:** Per org: ensure CMK (U8 resolver). Per encrypted row across all six
  columns: `decrypt-old` via the still-present pgcrypto helper + global key →
  `encryptForOrg` → write new ciphertext + set `*_version = <kms version>`. Idempotent
  (skip rows already at the KMS version). Resumable. Run during low traffic; the
  version columns detect stragglers (a write landing under the old key mid-pass is
  caught by a second pass). Google tokens set `key_org_id` during migration.
- **Execution note:** characterization-first — snapshot decrypted plaintext for a
  sample of rows before migration, assert byte-identical decrypt after.
- **Test scenarios:**
  - A row encrypted under the global key is re-encrypted and still decrypts to the same plaintext.
  - Idempotent: re-running skips already-migrated rows (no double-encrypt).
  - Resumable: interrupting mid-batch and re-running completes without gaps.
  - Straggler: a row written under the old key after a partial pass is migrated on the next pass.
- **Verification:** post-migration, every encrypted row is at the KMS version and decrypts via `decryptForOrg`; zero rows on the old version.

### U12. Per-org rotation + revocation; supersede `rewrap_encrypted_secrets`
- **Goal:** Operational per-org key rotation and instant revocation.
- **Requirements:** R4
- **Dependencies:** U9, U10, U11
- **Files:**
  - `apps/portal/src/inngest/functions/rotate-org-key.ts` (new) — re-encrypt one org's rows under a fresh data key / rotated CMK
  - `docs/runbooks/encryption-key-rotation.md` (rewrite for KMS/per-org model)
  - mark `public.rewrap_encrypted_secrets` for removal in U13
- **Approach:** CMK rotation is largely automatic (annual KMS key rotation) for the
  wrapping key; for a compromised org, **disable the CMK** (instant revocation — that
  org's data becomes undecryptable until re-enabled) and/or re-encrypt that org's rows
  under a new key. Document both. Rotation is now per-org and isolated — no global
  re-wrap.
- **Test scenarios:**
  - Rotating one org's key re-encrypts only that org's rows; other orgs untouched.
  - Disabling an org's CMK makes its ciphertext undecryptable (decrypt throws); re-enabling restores.
- **Verification:** runbook reflects KMS rotation/revoke; rotation job scoped to a single org.

### U13. Decommission legacy pgcrypto crypto path
- **Goal:** Remove the superseded global-key machinery once migration is verified.
- **Requirements:** R2 (no DB-side keys)
- **Dependencies:** U11 (verified), U12
- **Files:**
  - `supabase/migrations/<ts>_drop_pgcrypto_secret_helpers.sql` (drop `encrypt_refresh_token`, `decrypt_refresh_token`, `transcript_with_text`, `rewrap_encrypted_secrets`)
  - remove `USER_TOKEN_ENCRYPTION_KEY` from `.env.example` files and `requireTokenKey()`
  - delete `apps/bot-worker/src/token-crypto.ts` / `apps/portal/app/_lib/token-crypto.ts` legacy fns superseded by `packages/crypto`
- **Approach:** Gate on U11 verification (zero rows on old version). Drop the SQL
  helpers and the env key. Keep a documented rollback window before dropping.
- **Test scenarios:**
  - Full suite green with the global key and pgcrypto helpers removed.
  - No code path references `USER_TOKEN_ENCRYPTION_KEY` or the dropped RPCs.
- **Verification:** grep shows no remaining references; migrations apply cleanly.

### Stream 3 — Documentation

### U14. Update security documentation + sub-processors
- **Goal:** Reflect both streams in the durable security docs.
- **Requirements:** R1–R10 (documentation of)
- **Dependencies:** U6, U13
- **Files:**
  - `SECURITY.md` (per-tenant KMS custody model; service-role least-privilege model; link the inventory)
  - `docs/solutions/2026-06-03-content-encryption-at-rest.md` (replace pgcrypto-global section with KMS envelope; keep disk-only residual section)
  - `docs/runbooks/encryption-key-rotation.md` (KMS/per-org — done in U12, finalize)
  - `docs/security/sub-processors.md` (add **AWS KMS** as a sub-processor / infra dependency)
  - `docs/security/service-role-inventory.md` (cross-link)
- **Approach:** Rewrite the encryption-at-rest narrative around per-org CMKs,
  app-side AES, enc-context, audit + revocation; state the honest threat-model
  result (KMS custody is what addresses insider/app-compromise; corpus residual
  unchanged).
- **Test expectation:** none — documentation.
- **Verification:** docs describe the shipped scheme; AWS KMS listed as a sub-processor.

---

## Scope Boundaries

**In scope:** per-org AWS KMS envelope encryption for the six existing encrypted
columns; per-org rotation/revocation; service-role audit + `org_id` hardening +
cross-org guard; migration of read paths to the authenticated client; the
re-encryption migration; security-doc updates.

### Deferred to Follow-Up Work
- **Network Restrictions on the Postgres endpoint** (IP-allowlist the SQL port to
  Fly/portal egress). Complementary to this plan; note that it does **not** protect
  the HTTPS data APIs, so it is additive, not a substitute. Worth a small follow-up.
- **`pgaudit` / DB-level audit triggers** on sensitive tables for service-role write
  attribution.
- **Per-workload service-role keys/roles** (distinct keys for webhooks vs jobs) and
  dedicated `BYPASSRLS` Postgres roles instead of the global service-role key.
- **Migrating live-meeting mutations to column-scoped RLS** (trigger/per-column GRANT)
  if a future need outweighs keeping them as hardened service-role actions.

### Outside this plan
- Searchable-corpus encryption (`doc_chunks.text` + `corpus_chunk_embeddings.embedding`)
  — stays disk-encryption-only by design; cannot be column-encrypted without breaking
  FTS/vector search.
- TEE / confidential-compute and single-tenant / BYOK deployment tiers — product
  decisions tracked separately.

---

## Risks & Dependencies

| Risk | Impact | Mitigation |
| --- | --- | --- |
| KMS dependency in the transcript hot path | A KMS outage blocks transcript persistence / recap / synthesis writes | Caching CMM (R10) makes steady-state local; bound retries; on KMS failure fail the write durably and surface, do not silently drop — define degradation explicitly in U9 |
| AWS credentials now a high-value secret in Fly + portal env | Credential leak lets an attacker call KMS (bounded by IAM, observable in CloudTrail) | Least-privilege IAM (only `GenerateDataKey`/`Decrypt`/`CreateKey` on the org-key alias namespace); rotate; CloudTrail alerting |
| Per-org CMK cost / 100k-keys-per-region ceiling | Cost ~$1/org/mo; ceiling at scale | Acceptable for paying-customer orgs pre-launch; documented single-CMK+enc-context fallback (KTD2) |
| Re-encryption migration correctness | Data loss for non-regenerable content (recaps/transcripts/syntheses) | Idempotent + resumable + characterization snapshot (U11); keep pgcrypto helpers until verified (KTD7) |
| Multi-org user Google token keying | Token keyed under one org only | Org-of-record + `key_org_id` (KTD4); documented caveat |
| Migrating reads to RLS exposes missing SELECT policies | A read returns 0 rows where it used to return data | Verify/add column-scoped SELECT policies per migrated path; RLS tests for in-org success and out-of-org denial |

**Prerequisite:** F1/F2 encryption columns merged to base (branch
`fix/encrypt-transcripts-syntheses`).

**Dependency order:** Stream 1 `U1 → U2`, `U3`, `U4`, `U5 → U6` (parallelizable
within). Stream 2 `U7 → U8 → {U9, U10} → U11 → U12 → U13`. `U14` last.

---

## Sources & Research

- Repo map of all ~40 service-role call sites and the six encrypted columns
  (ce-repo-research-analyst, this session).
- `docs/solutions/2026-06-03-content-encryption-at-rest.md`; `docs/runbooks/encryption-key-rotation.md`;
  memory `rls-no-client-update-when-service-role-writes`, `eval-regression-coverage`.
- External (ce-best-practices-researcher): AWS KMS multi-tenant key strategy, AWS
  Encryption SDK data-key caching, encryption-context scoping, pgcrypto DEK-as-text
  pitfall, Supabase service-role least-privilege + Network Restrictions + role
  scoping. Load-bearing finding: only external KMS custody (with per-tenant key
  policy / per-org CMK) caps a compromised key to one org under the
  insider/app-compromise threat; in-app HKDF/envelope schemes do not.
