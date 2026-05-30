import type { CardEvent } from '../retrieve/contract.js';
import type { RelevanceResult } from '../relevance/contract.js';
import { normalizeForRelevance } from '../relevance/heuristic.js';

export interface ActiveSynthesis {
  readonly synthesisId: string;
  readonly sourceCardIds: readonly string[];
  readonly controller: AbortController;
  readonly startedAt: number;
  /**
   * Card IDs the model actually cited via [N] references in its output.
   * Set by `setSynthesisCitations` after the model finishes; undefined
   * while the synthesis is still streaming. Used by the retract cascade
   * to decide whether retracting a card invalidates this synthesis.
   */
  readonly citedCardIds?: readonly string[];
}

export interface MeetingSessionOptions {
  /**
   * Upper bound on how long a (docId, scope) pair is considered
   * "already seen" for dedup purposes. Dedup is **scoped by the embed
   * input** (the latest finalized utterance text) — so a doc surfaced
   * for question A does NOT dedup-block the same doc from surfacing
   * for question B, even when the retrieval happens to overlap. Within
   * a single question's debounce/windowChanged flush cycle, the TTL
   * still prevents duplicate card emissions.
   *
   * Default 120s. Set to `Infinity` for the legacy permanent-per-meeting
   * behavior keyed only by docId (no scope).
   */
  readonly surfacedTtlMs?: number;
  /**
   * How long a `skip` relevance-classifier decision is cached for repeat
   * utterances. Keyed by `normalizeForRelevance(utterance)` so trivial
   * transcription variants (`yeah`, `Yeah!`, `yeah.`) collide. Only skip
   * decisions are cached — surface decisions are not, since re-firing
   * the classifier on surface is the cheap path.
   */
  readonly relevanceCacheTtlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_SURFACED_TTL_MS = 120_000;
const DEFAULT_RELEVANCE_CACHE_TTL_MS = 30_000;

export class MeetingSession {
  readonly meetingId: string;
  readonly #surfacedAt = new Map<string, number>();
  readonly #pinnedIds = new Set<string>();
  readonly #cards = new Map<string, CardEvent>();
  readonly #syntheses = new Map<string, ActiveSynthesis>();
  readonly #relevanceCache = new Map<string, { result: RelevanceResult; at: number }>();
  readonly #surfacedTtlMs: number;
  readonly #relevanceCacheTtlMs: number;
  readonly #now: () => number;

  constructor(meetingId: string, options: MeetingSessionOptions = {}) {
    this.meetingId = meetingId;
    this.#surfacedTtlMs = options.surfacedTtlMs ?? DEFAULT_SURFACED_TTL_MS;
    this.#relevanceCacheTtlMs = options.relevanceCacheTtlMs ?? DEFAULT_RELEVANCE_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Returns true when the doc has been surfaced for the given scope
   * (typically the embed input — the latest finalized utterance text)
   * within the TTL window. A doc surfaced under a different scope is
   * NOT considered seen — the same retrieval result for a different
   * question is allowed to re-surface, which is what users expect
   * when they ask a follow-up question that happens to retrieve
   * overlapping documents.
   *
   * When scope is `undefined`, falls back to the legacy doc-only key —
   * preserves pinned-card lookups and existing test paths that don't
   * care about scoping.
   */
  hasSurfaced(docId: string, scope?: string): boolean {
    const key = scope === undefined ? docId : `${scope}::${docId}`;
    const at = this.#surfacedAt.get(key);
    if (at === undefined) return false;
    if (this.#surfacedTtlMs === Infinity) return true;
    return this.#now() - at < this.#surfacedTtlMs;
  }

  recordSurfaced(card: CardEvent, scope?: string): void {
    const key = scope === undefined ? card.docId : `${scope}::${card.docId}`;
    this.#surfacedAt.set(key, this.#now());
    this.#cards.set(card.cardId, card);
  }

  pin(cardId: string): boolean {
    if (!this.#cards.has(cardId)) return false;
    this.#pinnedIds.add(cardId);
    return true;
  }

  unpin(cardId: string): boolean {
    return this.#pinnedIds.delete(cardId);
  }

  isPinned(cardId: string): boolean {
    return this.#pinnedIds.has(cardId);
  }

  pinnedCards(): CardEvent[] {
    return [...this.#pinnedIds]
      .map((id) => this.#cards.get(id))
      .filter((c): c is CardEvent => c !== undefined);
  }

  surfacedCount(): number {
    return this.#surfacedAt.size;
  }

  // --- Relevance-classifier memoization ---
  //
  // Only `skip` decisions are recorded. Surface decisions intentionally
  // miss the cache so a re-fire goes through the classifier again — the
  // cost is one classifier call vs. risking a pinned wrong-surface
  // decision when the original was borderline.
  recordRelevance(utterance: string, result: RelevanceResult): void {
    if (result.decision !== 'skip') return;
    const key = normalizeForRelevance(utterance);
    if (key.length === 0) return;
    this.#relevanceCache.set(key, { result, at: this.#now() });
  }

  getCachedRelevance(utterance: string): RelevanceResult | null {
    const key = normalizeForRelevance(utterance);
    if (key.length === 0) return null;
    const entry = this.#relevanceCache.get(key);
    if (entry === undefined) return null;
    if (this.#now() - entry.at >= this.#relevanceCacheTtlMs) {
      this.#relevanceCache.delete(key);
      return null;
    }
    return entry.result;
  }

  // --- Synthesis tracking ---

  /**
   * Register an in-flight synthesis so the pipeline can abort it on the
   * next schedule and surface its cited card IDs to the retract cascade.
   * Only one active synthesis is expected at a time (a new schedule aborts
   * the prior one), but the map can hold multiple if external callers race
   * — clearSynthesis removes by id, not "current."
   */
  recordSynthesis(synthesis: ActiveSynthesis): void {
    this.#syntheses.set(synthesis.synthesisId, synthesis);
  }

  /**
   * Returns the most recently recorded active synthesis, or null. Iterates
   * insertion order so the most recent wins when more than one exists
   * (rare; should only happen in test setups that skip the abort step).
   */
  getActiveSynthesis(): ActiveSynthesis | null {
    let latest: ActiveSynthesis | null = null;
    for (const s of this.#syntheses.values()) latest = s;
    return latest;
  }

  /**
   * Patch citations onto a recorded synthesis. Called after the LLM
   * finishes streaming and the parser identifies which numbered sources
   * were cited; the rank→cardId mapping is sourceCardIds[N-1].
   */
  setSynthesisCitations(synthesisId: string, citedCardIds: readonly string[]): void {
    const existing = this.#syntheses.get(synthesisId);
    if (existing === undefined) return;
    this.#syntheses.set(synthesisId, { ...existing, citedCardIds });
  }

  /**
   * Returns the synthesis IDs that cited a given cardId. Used by the
   * retract cascade: when a source card is retracted, every synthesis
   * that cited it must also be retracted to keep provenance honest.
   */
  getSynthesesCiting(cardId: string): string[] {
    const matches: string[] = [];
    for (const s of this.#syntheses.values()) {
      if (s.citedCardIds?.includes(cardId) === true) matches.push(s.synthesisId);
    }
    return matches;
  }

  clearSynthesis(synthesisId: string): void {
    this.#syntheses.delete(synthesisId);
  }

  clear(): void {
    this.#surfacedAt.clear();
    this.#pinnedIds.clear();
    this.#cards.clear();
    this.#relevanceCache.clear();
    for (const s of this.#syntheses.values()) {
      try {
        s.controller.abort();
      } catch {
        // already aborted
      }
    }
    this.#syntheses.clear();
  }
}
