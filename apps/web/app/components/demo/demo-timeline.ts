import type { DemoCard, DemoSynthesis, TranscriptLine } from './types';

/**
 * Canned timeline for the simulated meeting. The demo plays a believable
 * engineering standup: transcript streams, a detected question surfaces RAG
 * cards, and an AI Summary types out a cited answer. No daemon, no network —
 * the data is fixed and the reducer below is pure (plan U6 / KTD4).
 *
 * Event kinds echo the HUD's ServerMessage names (apps/hud/src/types.ts) for
 * realism; this is a simplified local copy, not an import.
 */
export type DemoEvent =
  | { readonly kind: 'transcript'; readonly line: TranscriptLine }
  | { readonly kind: 'card'; readonly card: DemoCard }
  | { readonly kind: 'synthesisStart' }
  | { readonly kind: 'synthesisDelta'; readonly delta: string }
  | {
      readonly kind: 'synthesisDone';
      readonly citations: readonly number[];
      readonly sources: readonly DemoCard[];
    };

export interface TimelineEntry {
  readonly atMs: number;
  readonly event: DemoEvent;
}

export interface DemoState {
  readonly transcript: readonly TranscriptLine[];
  readonly cards: readonly DemoCard[];
  readonly synthesis: {
    readonly text: string;
    readonly streaming: boolean;
    readonly citations: readonly number[];
    readonly sources: readonly DemoCard[];
  } | null;
}

export const INITIAL_STATE: DemoState = {
  transcript: [],
  cards: [],
  synthesis: null,
};

const PR_CARD: DemoCard = {
  id: 'pr-482',
  source: 'github',
  type: 'pull-request',
  title: 'Auth migration to OAuth2 (#482)',
  snippet: 'Swaps the legacy session cookies for OAuth2 bearer tokens. 14 files changed.',
  meta: 'Open · review requested',
  rank: 1,
};

const JIRA_CARD: DemoCard = {
  id: 'auth-204',
  source: 'jira',
  type: 'issue',
  title: 'AUTH-204 — OAuth2 cutover',
  snippet: 'Epic tracking the OAuth2 cutover across services.',
  meta: 'In Progress · assigned to Marco',
  rank: 2,
};

const DOC_CARD: DemoCard = {
  id: 'doc-auth',
  source: 'github',
  type: 'doc',
  title: 'docs/auth-migration.md',
  docHeading: '## Rollout & cutover',
  snippet: 'Staged rollout: internal users first, then a 10% canary, then full traffic.',
  rank: 3,
};

const SYNTHESIS_SOURCES: readonly DemoCard[] = [PR_CARD, JIRA_CARD, DOC_CARD];

const SYNTHESIS_CHUNKS: readonly string[] = [
  'The auth migration is in flight: PR #482 swaps session cookies for ',
  'OAuth2 and is open, waiting on review [1]. ',
  "It's tracked under AUTH-204, currently in progress with Marco [2]. ",
  'Rollout is staged — internal, then a 10% canary, then full [3].',
];

/** Full answer text, assembled from the streamed chunks. */
export const SYNTHESIS_TEXT: string = SYNTHESIS_CHUNKS.join('');

export const TIMELINE: readonly TimelineEntry[] = [
  {
    atMs: 300,
    event: {
      kind: 'transcript',
      line: { id: 't1', speaker: 'Priya', text: 'Standups — Marco, where are we on the auth migration?' },
    },
  },
  {
    atMs: 3200,
    event: {
      kind: 'transcript',
      line: {
        id: 't2',
        speaker: 'Marco',
        text: "Still wrapping it up. Remind me — what's the status of the auth migration PR?",
      },
    },
  },
  { atMs: 4400, event: { kind: 'card', card: PR_CARD } },
  { atMs: 5200, event: { kind: 'card', card: JIRA_CARD } },
  { atMs: 6000, event: { kind: 'card', card: DOC_CARD } },
  { atMs: 7000, event: { kind: 'synthesisStart' } },
  { atMs: 7000, event: { kind: 'synthesisDelta', delta: SYNTHESIS_CHUNKS[0]! } },
  { atMs: 7900, event: { kind: 'synthesisDelta', delta: SYNTHESIS_CHUNKS[1]! } },
  { atMs: 8800, event: { kind: 'synthesisDelta', delta: SYNTHESIS_CHUNKS[2]! } },
  { atMs: 9700, event: { kind: 'synthesisDelta', delta: SYNTHESIS_CHUNKS[3]! } },
  {
    atMs: 10600,
    event: { kind: 'synthesisDone', citations: [1, 2, 3], sources: SYNTHESIS_SOURCES },
  },
];

/** When the last event has fired; the player holds here before looping. */
export const TIMELINE_END_MS: number = TIMELINE.reduce((max, e) => Math.max(max, e.atMs), 0);

/** Hold on the finished scene (the completed AI Summary) before looping. */
export const LOOP_HOLD_MS = 8000;

/** Total cycle length including the end-hold. */
export const TIMELINE_DURATION_MS: number = TIMELINE_END_MS + LOOP_HOLD_MS;

/** Pure reducer: fold a single event into the demo state. */
export function applyEvent(state: DemoState, event: DemoEvent): DemoState {
  switch (event.kind) {
    case 'transcript':
      return { ...state, transcript: [...state.transcript, event.line] };
    case 'card':
      return { ...state, cards: [...state.cards, event.card] };
    case 'synthesisStart':
      return { ...state, synthesis: { text: '', streaming: true, citations: [], sources: [] } };
    case 'synthesisDelta': {
      if (state.synthesis === null) return state;
      return {
        ...state,
        synthesis: { ...state.synthesis, text: state.synthesis.text + event.delta },
      };
    }
    case 'synthesisDone': {
      if (state.synthesis === null) return state;
      return {
        ...state,
        synthesis: {
          ...state.synthesis,
          streaming: false,
          citations: event.citations,
          sources: event.sources,
        },
      };
    }
  }
}

/**
 * Pure fold of every timeline event with `atMs <= elapsedMs`. Used both for the
 * live player (advancing cursor) and for the reduced-motion end-state
 * (`elapsedMs = Infinity` yields the terminal scene).
 */
export function stateAtElapsed(elapsedMs: number, timeline: readonly TimelineEntry[] = TIMELINE): DemoState {
  let state = INITIAL_STATE;
  for (const entry of timeline) {
    if (entry.atMs <= elapsedMs) {
      state = applyEvent(state, entry.event);
    }
  }
  return state;
}

/** The fully-played scene (all cards + finished synthesis). */
export function terminalState(): DemoState {
  return stateAtElapsed(Number.POSITIVE_INFINITY);
}

/** Convenience for tests/consumers wanting the finished synthesis shape. */
export const FINAL_SYNTHESIS: DemoSynthesis = {
  text: SYNTHESIS_TEXT,
  citations: [1, 2, 3],
  sources: SYNTHESIS_SOURCES,
};
