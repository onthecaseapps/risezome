// Public barrel for @risezome/hud-ui.
//
// Consumers (apps/hud-next, apps/portal's live-meeting page) import
// components and types from here so visual changes are made in one
// place and apply to both surfaces.

// Types — the WS message union + card/synthesis shapes the engine emits.
export * from './types';

// Components (Bootstrap intentionally NOT exported — it's WS-coupled
// and lives in hud-next's own app/lib/bootstrap.tsx. The portal's
// live-meeting page will compose its own Realtime-driven wrapper.)
export { CardHeaderRow } from './components/card-bits';
export { CardStream } from './components/card-stream';
export { CitationChip } from './components/citation-chip';
export { EmptyState } from './components/empty-state';
export { TypeGlyph, PinGlyph } from './components/glyphs';
export { HudCard } from './components/hud-card';
export { HudShell } from './components/hud-shell';
export { PinnedSection } from './components/pinned-section';
export { PinnedSynthesesSection } from './components/pinned-syntheses-section';
export { SourceCardExpanded } from './components/source-card-expanded';
export { SynthesisAnnounce } from './components/synthesis-announce';
export { SynthesisCard, type SynthesisPhase } from './components/synthesis-card';
export { SynthesisStream } from './components/synthesis-stream';
export { ThemeToggle } from './components/theme-toggle';

// State
export {
  AppStateProvider,
  useAppDispatch,
  useAppState,
  appStateReducer,
  initialAppState,
  SYNTHESIS_PAUSED_THRESHOLD,
  type AppState,
  type AppAction,
  type CardRecord,
  type SynthesisRecord,
  type MeetingMode,
} from './state/app-state';
export {
  CardActionsProvider,
  useCardActions,
  type CardActions,
} from './state/card-actions';
export {
  SynthesisActionsProvider,
  useSynthesisActions,
  type SynthesisActions,
} from './state/synthesis-actions';

// Lib
export {
  THEME_STORAGE_KEY,
  THEME_INIT_SCRIPT,
  readStoredTheme,
  writeStoredTheme,
  applyTheme,
  resolveEffectiveTheme,
  type ThemePreference,
} from './lib/theme';
export { findQuoteInBody, type QuoteMatch } from './lib/quote-match';
