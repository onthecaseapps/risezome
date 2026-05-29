# Upwell

A desktop meeting-context copilot. Listens to your meeting locally, surfaces relevant context from your connected sources (GitHub, Jira in v1), and captures unanswered questions to feed back into documentation.

> Status: early development. v1 is Linux-only; macOS and Windows are planned follow-ups. See [`docs/plans/`](docs/plans/) for the active plan.

## Architecture at a glance

- **Node/TypeScript daemon** runs in the background, exposes a local HTTP + WebSocket server on `127.0.0.1`.
- **Per-OS native sidecar** captures system audio + microphone, streams framed PCM to the daemon over stdio.
- **HUD** is a single-page web app served from the daemon and opened in your browser at `http://localhost:<port>`.
- **Corpus** is an embedded SQLite database with `sqlite-vec` + FTS5 for hybrid vector + BM25 retrieval.
- **Pluggable source connectors** follow an MCP-style contract; GitHub and Jira ship in v1.

## Development

Requirements: Node ≥ 22, pnpm ≥ 9, Linux (Ubuntu 24.04+ recommended).

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Documentation

- [Product framing (brainstorm)](docs/brainstorms/meeting-context-copilot-requirements.md)
- [Implementation plan](docs/plans/2026-05-28-001-feat-meeting-context-copilot-plan.md)
- [Conventions for contributors and agents (AGENTS.md)](AGENTS.md)
