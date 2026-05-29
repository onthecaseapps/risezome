/**
 * Local demo types. These deliberately echo the HUD's event/card shapes
 * (apps/hud/src/types.ts) for realism but are a simplified, self-contained
 * copy — the demo imports no product code and talks to no daemon (plan KTD4).
 */

export type DemoSource = 'github' | 'jira' | 'slack' | 'code';

export type DemoType = 'issue' | 'pull-request' | 'code' | 'doc';

export interface DemoCard {
  readonly id: string;
  readonly source: DemoSource;
  readonly type: DemoType;
  /** Title text — a file path, PR/issue title, or doc name. */
  readonly title: string;
  /** Muted secondary line (e.g. a doc heading "## Phase 1.5 — …"). */
  readonly docHeading?: string;
  readonly snippet: string;
  /** 1 = top match (accent "Top match" label); otherwise "Match". */
  readonly rank: number;
  /** Optional source metadata shown in the header (e.g. "Open · review requested"). */
  readonly meta?: string;
}

export interface TranscriptLine {
  readonly id: string;
  readonly speaker: string;
  readonly text: string;
}

export interface DemoSynthesis {
  /** Answer text. May contain inline citation markers like "[1]". */
  readonly text: string;
  /** Ranks (1-based) cited by the answer, in order of first appearance. */
  readonly citations: readonly number[];
  /** Source cards consolidated beneath the answer. */
  readonly sources: readonly DemoCard[];
}
