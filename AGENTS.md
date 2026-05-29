# AGENTS.md

Conventions and guardrails for agents and humans working in this repo.

## What this is

Upwell is a desktop meeting-context copilot. A Node/TypeScript background daemon captures local meeting audio (via per-OS native sidecars), transcribes it in real time, indexes connected sources (GitHub + Jira in v1), continuously surfaces relevant context as cards in a browser-based HUD, and captures unanswered questions to feed back into documentation improvement.

The authoritative scope, design decisions, and implementation units live in `docs/plans/2026-05-28-001-feat-meeting-context-copilot-plan.md`. The product framing lives in `docs/brainstorms/meeting-context-copilot-requirements.md`.

## Repository layout

```
upwell/
├── apps/
│   ├── daemon/                       # Node TS daemon
│   └── hud/                          # HUD single-page web app
├── sidecars/
│   ├── linux/                        # PipeWire wrapper binary
│   ├── mac/                          # ScreenCaptureKit binary  (deferred to v1.5)
│   └── win/                          # WASAPI loopback binary   (deferred to v1.6+)
├── packages/
│   └── shared-types/                 # Cross-package TypeScript types
└── docs/
    ├── brainstorms/                  # Product framing
    └── plans/                        # Implementation plans
```

## Build & development

- **Package manager:** `pnpm` (workspaces). Use `pnpm install` at the repo root.
- **Node:** `>= 22`.
- **Commands:**
  - `pnpm typecheck` — TS project-references build with no emit.
  - `pnpm lint` — ESLint flat config.
  - `pnpm format` / `pnpm format:check` — Prettier.
  - `pnpm test` — Vitest run.
  - `pnpm build` — TS project-references build.
  - `pnpm daemon <serve|index|consent> [...]` — run the daemon CLI via tsx.

## Secrets and env files

The daemon CLI loads env vars from `.env` files in this order (later sources do not overwrite earlier ones, and **shell-exported vars always win**):

1. `$UPWELL_ENV_FILE` if set (explicit override).
2. `<data dir>/.env` (e.g. `~/.local/share/upwell/.env` on Linux).
3. `./.env` (current working directory).

Copy `.env.example` to `.env` and fill in your keys. `.env`, `.env.local`, and `.env.*.local` are already in `.gitignore`. The plan's documented end state for secrets is the OS keychain (U22); the `.env` file path is the dev shortcut and is fine for solo dev on a personal machine.

## TypeScript conventions

- **Strict mode** is non-negotiable. `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`.
- **No `any`** except at genuine FFI seams (native sidecar IPC, ONNX runtime calls, sqlite-vec extension). Wrap these in typed adapters at the seam.
- **Repo-relative imports.** Use workspace package names (`@upwell/shared-types`) — never relative paths that cross package boundaries.
- **File naming:** `kebab-case.ts` for files, `PascalCase` for classes/types, `camelCase` for functions/variables.
- **Tests** live in `test/` mirroring `src/` per package. File suffix `.test.ts`.
- **Type imports:** prefer `import type { ... }` or inline `import { type ... }`.

## Error handling conventions

- **Typed errors with stable codes.** Each subsystem defines its own error classes; never throw bare `Error`. Stable codes feed the WebSocket error event (U5) and the user-facing error toasts.
- **No silent swallowing.** Errors propagate or surface as typed events; the daemon never hides failure.
- **Sanitization at the WS boundary.** `error` events carry only `{ code, userMessage }`. Stack traces and `cause.message` stay in local logs.
- **Secret redaction at every logger sink.** Allowlist scrub on `Authorization`, `X-Atlassian-Token`, `Cookie`, `Set-Cookie`, `Proxy-Authorization` headers and `token` / `access_token` / `api_key` URL parameters.

## Security defaults (see U5, U6, U7, U22, U25 of the plan)

- Daemon binds to `127.0.0.1` only.
- All mutating HTTP routes and the WebSocket require a **per-session bearer token** generated at startup.
- HTTP mutating routes require `Content-Type: application/json` (no form-submittable types).
- HUD bootstrap response includes a strict CSP.
- SQLite DB file is mode `0600` on POSIX.
- Sidecars are integrity-checked (SHA-256 against an embedded manifest) and authenticated via a per-launch IPC nonce.
- Outbound network calls are gated by the `consent` table.

## Standards for plans

- Plans live in `docs/plans/`. Filename format: `YYYY-MM-DD-NNN-<type>-<descriptive-name>-plan.md`.
- Plan U-IDs (`U1`, `U2`, …) are stable. Never renumber them, even after reordering, splitting, or deleting units. Gaps are fine.

## What goes where

- **Product framing or "what" questions** → `docs/brainstorms/`.
- **Architecture, implementation units, and "how" questions** → `docs/plans/`.
- **Cross-cutting code conventions** → this file.
- **Per-package developer notes** → `apps/<name>/README.md` or `packages/<name>/README.md`.

## What NOT to do

- Do not commit secrets, API keys, or `.env` files.
- Do not introduce backwards-compatibility shims for unused branches.
- Do not add hypothetical-future-use abstractions; YAGNI applies to carrying cost.
- Do not write multi-line comment blocks; well-named identifiers do that job.
- Do not skip pre-commit hooks (`--no-verify`) unless explicitly asked.
- Do not push to `main` without explicit user permission once the project has any non-scaffolding commits.
