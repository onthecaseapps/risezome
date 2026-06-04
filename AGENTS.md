# AGENTS.md

Conventions and guardrails for agents and humans working in this repo.

## What this is

Risezome is a cloud meeting-context copilot. A Recall.ai bot joins a user's meeting, streams the transcript to a long-lived **bot-worker** service, which embeds each utterance, retrieves relevant context from a per-org corpus, optionally routes the query to a skill, synthesizes a cited answer with Claude, and broadcasts it to a **portal** live page over Supabase Realtime. Background **Inngest** jobs launch the bots and index connected sources (GitHub, Trello, Jira, Confluence) into the corpus.

The product is cloud-hosted (portal on Vercel, bot-worker on Fly.io, data in Supabase). The native audio `sidecars/` are a **dev-only** local-mic debug path: they feed live microphone audio through Deepgram into the exact same bot-worker retrieval/synthesis pipeline as the Recall bot, so the pipeline can be exercised locally without a meeting. They are not shipped to users.

Historical implementation plans and product framing live under `docs/plans/archive/` and `docs/brainstorms/archive/`.

## Repository layout

```
risezome/
├── apps/
│   ├── portal/                        # Next.js App Router web app (Vercel) — auth, connectors, meeting pages, Inngest endpoint
│   └── bot-worker/                    # Fastify WS service (Fly.io) — Recall bot ingest, retrieval, synthesis, broadcast
├── packages/
│   ├── engine/                        # Shared core: chunker, embed, synthesize, relevance, router, skills, summarize
│   ├── crypto/                        # Per-org envelope encryption (AWS Encryption SDK + KMS); shared by portal + bot-worker
│   ├── hud-ui/                        # React components for the live HUD (cards, synthesis, citations)
│   └── shared-types/                  # Cross-package TypeScript types
├── sidecars/
│   ├── linux/                         # PipeWire/PulseAudio capture binary (dev-only local-mic debug)
│   └── macos/                         # CoreAudio capture binary (dev-only local-mic debug)
├── supabase/
│   ├── migrations/                    # Postgres + pgvector schema, RLS policies
│   └── config.toml                    # Local Supabase config
└── docs/
    ├── runbooks/                      # Operational runbooks (live)
    ├── plans/archive/                 # Historical implementation plans
    └── brainstorms/archive/           # Historical product framing
```

## Build & development

- **Package manager:** `pnpm` (workspaces). Run `pnpm install` at the repo root.
- **Node:** `>= 22`.
- **Commands (root):**
  - `pnpm typecheck` — `tsc --noEmit` across all packages.
  - `pnpm lint` — ESLint flat config.
  - `pnpm format` / `pnpm format:check` — Prettier.
  - `pnpm test` — Vitest run.
  - `pnpm build` — build all packages.
- **Per-app dev:** run from the app dir (`pnpm --filter @risezome/portal dev`, `pnpm --filter @risezome/bot-worker dev`). Each app has its own `.env.example` and README with setup specifics.
- **Shared packages** (`@risezome/engine`, `@risezome/crypto`, `@risezome/hud-ui`, `@risezome/shared-types`) must be built before an app typechecks against fresh changes: `pnpm --filter @risezome/shared-types --filter @risezome/engine --filter @risezome/crypto --filter @risezome/hud-ui build`.

## Secrets and env files

- Each app loads its own `.env` (see `apps/<name>/.env.example`). The dev-only local-mic sidecar vars (`RISEZOME_SIDECAR_PATH`, `RISEZOME_SIDECAR_SHA`, `PULSE_SOURCE`) are documented in `apps/bot-worker/src/debug/README.md` and auto-configured by the dev console.
- Copy the relevant `.env.example` to `.env` and fill in keys. `.env`, `.env.local`, and `.env.*.local` are gitignored.
- **Never commit secrets, API keys, or `.env` files.** Service-role keys (Supabase secret key, `BOT_WORKER_SECRET`, OAuth client secrets, provider API keys) are server-only — never expose them to the browser or a `NEXT_PUBLIC_*` var.
- Connector access tokens (GitHub installation, Trello, Atlassian) are stored in Supabase tables protected by RLS with **no policies** (service-role-only access); the bot-worker and Inngest jobs read them with the service-role client.

## TypeScript conventions

- **Strict mode** is non-negotiable: `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`.
- **No `any`** except at genuine FFI/SDK seams. Wrap these in typed adapters at the seam.
- **Workspace imports.** Use package names (`@risezome/engine`, `@risezome/shared-types`) — never relative paths that cross package boundaries.
- **File naming:** `kebab-case.ts` for files, `PascalCase` for classes/types, `camelCase` for functions/variables.
- **Tests** live in `test/` mirroring `src/` per package. File suffix `.test.ts` / `.test.tsx`.
- **Type imports:** prefer `import type { ... }` or inline `import { type ... }`.

## Error handling conventions

- **Typed errors with stable codes.** Each subsystem defines its own error classes; never throw bare `Error`. Stable codes feed user-facing surfaces (synthesis error events, source `status='errored'` reconnect prompts, etc.).
- **No silent swallowing.** Errors propagate or surface as typed events.
- **Secret redaction at logger sinks.** Scrub `Authorization`, `Cookie`/`Set-Cookie`, `Proxy-Authorization` headers and `token` / `access_token` / `api_key` URL parameters.
- **Rate limits are first-class.** Embedding (Voyage) and connector (GitHub/Atlassian) rate limits surface as typed errors and are retried via Inngest/backoff rather than dropped.

## Security defaults (cloud)

- **Supabase RLS** on every org-scoped table; users see only their org's rows. The browser uses the publishable (anon) key; the bot-worker and Inngest jobs use the service-role key server-side only.
- **Recall ↔ bot-worker** WebSocket is authenticated with a per-meeting JWT (`BOT_WORKER_SECRET`), bound to the `meetingId` and time-limited.
- **Recall webhooks** are Svix-signed; verify the signature before acting.
- **Zero Data Retention** is enforced on Recall bot creation (`recording_config` / retention set to fail-closed).
- **OAuth secrets and connector tokens** stay server-side; refresh-token rotation (Atlassian) is handled with guarded updates and in-process coalescing.
- The dev-only local-mic debug path verifies the audio sidecar binary by SHA and uses an IPC nonce, but that path is not part of the product's security model.

## Standards for plans

- New plans live in `docs/plans/`; historical ones in `docs/plans/archive/`. Filename format: `YYYY-MM-DD-NNN-<type>-<descriptive-name>-plan.md`.
- Plan U-IDs (`U1`, `U2`, …) are stable. Never renumber them, even after reordering, splitting, or deleting units. Gaps are fine.
- A plan's `status:` frontmatter is `active` while in flight, then `completed` or `superseded` when done; archive it under `docs/plans/archive/` once closed.

## What goes where

- **Product framing or "what" questions** → `docs/brainstorms/`.
- **Architecture, implementation units, and "how" questions** → `docs/plans/`.
- **Cross-cutting code conventions** → this file.
- **Per-package developer notes** → `apps/<name>/README.md` or `packages/<name>/README.md`.
- **Operational procedures** → `docs/runbooks/`.

## What NOT to do

- Do not commit secrets, API keys, or `.env` files.
- Do not build product features into the dev-only `sidecars/` local-mic debug path — build in the portal, bot-worker, or shared packages.
- Do not introduce backwards-compatibility shims for unused branches.
- Do not add hypothetical-future-use abstractions; YAGNI applies to carrying cost.
- Do not write multi-line comment blocks where well-named identifiers do the job.
- Do not skip pre-commit hooks (`--no-verify`) unless explicitly asked.
- Do not push to `main` or open a PR without explicit user permission.
