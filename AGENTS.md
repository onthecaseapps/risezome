# AGENTS.md

Conventions and guardrails for agents and humans working in this repo.

## What this is

Risezome is a cloud meeting-context copilot. A Recall.ai bot joins a user's meeting, streams the transcript to a long-lived **bot-worker** service, which embeds each utterance, retrieves relevant context from a per-org corpus, optionally routes the query to a skill, synthesizes a cited answer with Claude, and broadcasts it to a **portal** live page over Supabase Realtime. Background **Inngest** jobs launch the bots and index connected sources (GitHub, Trello, Jira, Confluence) into the corpus.

The product is cloud-hosted (portal on Vercel, bot-worker on Fly.io, data in Supabase). The original local desktop daemon (`apps/daemon`), its native audio sidecars (`sidecars/`), and the standalone HUD app (`apps/hud-next`) are **legacy** from an earlier local-capture era. They are kept for reference and a dev-only local-mic debug path, but they are not part of the shipping product — do not extend them when adding product features.

Historical implementation plans and product framing live under `docs/plans/archive/` and `docs/brainstorms/archive/`.

## Repository layout

```
risezome/
├── apps/
│   ├── portal/                        # Next.js App Router web app (Vercel) — auth, connectors, meeting pages, Inngest endpoint
│   ├── bot-worker/                    # Fastify WS service (Fly.io) — Recall bot ingest, retrieval, synthesis, broadcast
│   ├── daemon/                        # LEGACY desktop daemon (local SQLite corpus + sidecar audio)
│   └── hud-next/                      # LEGACY standalone HUD app (superseded by portal + @risezome/hud-ui)
├── packages/
│   ├── engine/                        # Shared core: chunker, embed, synthesize, relevance, router, skills, summarize
│   ├── hud-ui/                        # React components for the live HUD (cards, synthesis, citations)
│   └── shared-types/                  # Cross-package TypeScript types
├── sidecars/
│   └── linux/                         # LEGACY PipeWire/PulseAudio capture binary (dev-only local-mic debug)
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
- **Shared packages** (`@risezome/engine`, `@risezome/hud-ui`, `@risezome/shared-types`) must be built before an app typechecks against fresh changes: `pnpm --filter @risezome/shared-types --filter @risezome/engine --filter @risezome/hud-ui build`.

## Secrets and env files

- Each app loads its own `.env` (see `apps/<name>/.env.example`). The root `.env.example` documents the legacy daemon's vars.
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
- The legacy daemon's local defaults (127.0.0.1 binding, per-session bearer token, SQLite `0600`, sidecar SHA + IPC nonce, consent gating) still apply to that legacy surface but are not the product's security model.

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
- Do not extend the legacy daemon / hud-next / sidecars when building product features — build in the portal, bot-worker, or shared packages.
- Do not introduce backwards-compatibility shims for unused branches.
- Do not add hypothetical-future-use abstractions; YAGNI applies to carrying cost.
- Do not write multi-line comment blocks where well-named identifiers do the job.
- Do not skip pre-commit hooks (`--no-verify`) unless explicitly asked.
- Do not push to `main` or open a PR without explicit user permission.
