// Public barrel for @risezome/hud-ui.
//
// Consumers (apps/hud-next, apps/portal's live-meeting page) import
// components and types from here so visual changes are made in one
// place and apply to both surfaces.

// Types — the WS message union + card/synthesis shapes the engine emits.
export * from './types.js';

// Components (Bootstrap intentionally NOT exported — it's WS-coupled
// and lives in hud-next's own app/lib/bootstrap.tsx. The portal's
// live-meeting page will compose its own Realtime-driven wrapper.)
export { CardHeaderRow } from './components/card-bits.js';
export { CardStream } from './components/card-stream.js';
export { CitationChip } from './components/citation-chip.js';
export { EmptyState } from './components/empty-state.js';
export { TypeGlyph, PinGlyph } from './components/glyphs.js';
export { HudCard } from './components/hud-card.js';
export { HudShell } from './components/hud-shell.js';
export { PinnedSection } from './components/pinned-section.js';
export { SynthesisAnnounce } from './components/synthesis-announce.js';
export { SynthesisCard } from './components/synthesis-card.js';
export { SynthesisStream } from './components/synthesis-stream.js';
export { ThemeToggle } from './components/theme-toggle.js';

// State
export {
  AppStateProvider,
  useAppDispatch,
  useAppState,
  appStateReducer,
  initialAppState,
  type AppState,
  type AppAction,
  type CardRecord,
  type SynthesisRecord,
  type MeetingMode,
} from './state/app-state.js';

// Lib
export { THEME_STORAGE_KEY, THEME_INIT_SCRIPT } from './lib/theme.js';
