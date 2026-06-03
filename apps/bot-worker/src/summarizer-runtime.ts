/**
 * Per-meeting rolling-summary runtime — DEMAND-DRIVEN.
 *
 * The rolling summary exists to give synthesis (and the router/relevance
 * classifiers) long-range meeting context: current_topic, open_questions,
 * key_terms, and a prose recap. Its only real consumer is a question being
 * answered — so the summary is refreshed lazily, not on a clock.
 *
 * It does NOT run on a timer or an utterance cadence. The owner calls
 * `refreshIfStale()` at the moment a synthesis is requested; the summary only
 * re-runs if it is older than `refreshStalenessMs` (or has never run). A
 * meeting with no questions never pays for a summary; a chatty Q&A refreshes at
 * most once per staleness window instead of every ~2 minutes.
 *
 * The refresh is asynchronous and best-effort: it does NOT block the in-flight
 * synthesis (which already captured `getLastSummary()` for its recentContext).
 * The fresh summary lands for the NEXT question, so an answer never waits on a
 * summary call. The triggering utterance is recorded before retrieval runs, so
 * a refresh fired from the synthesis path sees the question that prompted it.
 *
 * Lifecycle:
 *   const rt = new MeetingSummarizerRuntime({ summarizer, onSummaryUpdated })
 *   rt.recordUtterance("...")     // per final utterance — accumulates only
 *   rt.refreshIfStale()           // when a synthesis is requested
 *   rt.getLastSummary()           // atomic read at recentContext-build time
 *   rt.dispose()                  // when the meeting ends
 */

import type { MeetingSummary, Summarizer, SummarizerInput } from '@risezome/engine/summarize';

/** Minimum age of the current summary before a synthesis-driven refresh
 *  re-runs it. A fresher summary is reused as-is. Default 5 minutes. */
export const DEFAULT_REFRESH_STALENESS_MS = 300_000;
/** Sliding-window cap on the transcript fed to the summarizer; the head is
 *  trimmed past this and prior-summary carry-forward preserves aged-out facts. */
export const DEFAULT_TRANSCRIPT_CHAR_CAP = 20_000;
/** How many recent grounded assistant answers to carry into the summarizer so
 *  it can retire questions it has already answered (close-the-loop). */
export const RESOLVED_ANSWERS_CAP = 8;

export interface MeetingSummarizerRuntimeOptions {
  readonly summarizer: Summarizer;
  /** Fires when a new summary lands. The owner broadcasts (debug WS) or
   *  stores + logs (Recall production). */
  readonly onSummaryUpdated: (summary: MeetingSummary, at: number) => void;
  /** Optional error sink. Refusals + provider errors are non-fatal; the prior
   *  `lastSummary` is retained. */
  readonly onSummarizerError?: (err: unknown) => void;
  /** Override the clock (tests). */
  readonly now?: () => number;
  /** Min age before a synthesis-driven refresh re-runs the summary. Default 5m. */
  readonly refreshStalenessMs?: number;
  /** Transcript sliding-window cap. Default 20_000 chars. */
  readonly transcriptCharCap?: number;
}

export class MeetingSummarizerRuntime {
  readonly #summarizer: Summarizer;
  readonly #onSummaryUpdated: (summary: MeetingSummary, at: number) => void;
  readonly #onError: ((err: unknown) => void) | undefined;
  readonly #now: () => number;
  readonly #refreshStalenessMs: number;
  readonly #transcriptCharCap: number;

  #transcript = '';
  /** Recent grounded assistant answers (most recent last), capped to
   *  RESOLVED_ANSWERS_CAP. Fed to the summarizer so an on-screen answer
   *  retires the open question that prompted it (close-the-loop). */
  #resolvedAnswers: string[] = [];
  #lastSummary: MeetingSummary | null = null;
  /** Wall-clock at which the last summary completed; 0 before the first call
   *  (interpreted as "never summarized" → always stale). */
  #lastSummaryAt = 0;
  #inFlight = false;
  #disposed = false;

  constructor(options: MeetingSummarizerRuntimeOptions) {
    this.#summarizer = options.summarizer;
    this.#onSummaryUpdated = options.onSummaryUpdated;
    this.#onError = options.onSummarizerError;
    this.#now = options.now ?? Date.now;
    this.#refreshStalenessMs = options.refreshStalenessMs ?? DEFAULT_REFRESH_STALENESS_MS;
    this.#transcriptCharCap = options.transcriptCharCap ?? DEFAULT_TRANSCRIPT_CHAR_CAP;
  }

  /**
   * Record a finalized utterance. Cheap + synchronous — just appends to the
   * capped transcript window. Does NOT trigger a summary (that's demand-driven
   * via refreshIfStale).
   */
  recordUtterance(text: string): void {
    if (this.#disposed) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.#appendToTranscript(trimmed);
  }

  /**
   * Record a grounded answer the assistant just showed on-screen, so the next
   * summary can drop the open question it resolved (close-the-loop). The answer
   * is never spoken, so it never reaches the transcript on its own.
   */
  recordAssistantAnswer(text: string): void {
    if (this.#disposed) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.#resolvedAnswers.push(trimmed);
    if (this.#resolvedAnswers.length > RESOLVED_ANSWERS_CAP) {
      this.#resolvedAnswers = this.#resolvedAnswers.slice(-RESOLVED_ANSWERS_CAP);
    }
  }

  /**
   * Refresh the summary IF it's stale — called when a synthesis is requested.
   * The summary only feeds answering, so this is the only thing that should
   * make it run. No-ops when: disposed, a refresh is already in flight, there's
   * no transcript yet, or the current summary is younger than the staleness
   * window. Async — the refreshed summary lands for the next question.
   */
  refreshIfStale(): void {
    if (this.#disposed || this.#inFlight) return;
    if (this.#transcript.length === 0) return;
    const stale =
      this.#lastSummaryAt === 0 || this.#now() - this.#lastSummaryAt >= this.#refreshStalenessMs;
    if (!stale) return;
    this.#fire();
  }

  /** Read the latest summary atomically. Null before the first summary fires.
   *  Callers MUST read this once at the point they build downstream context
   *  (recentContext for synthesis) and MUST NOT re-read across an async
   *  boundary. */
  getLastSummary(): MeetingSummary | null {
    return this.#lastSummary;
  }

  /** Mark disposed. In-flight summarizer calls resolve normally but their
   *  results are ignored (no callback fires after dispose). */
  dispose(): void {
    this.#disposed = true;
  }

  #appendToTranscript(text: string): void {
    if (this.#transcript.length === 0) {
      this.#transcript = text;
    } else {
      this.#transcript = `${this.#transcript}\n${text}`;
    }
    if (this.#transcript.length > this.#transcriptCharCap) {
      this.#transcript = this.#transcript.slice(this.#transcript.length - this.#transcriptCharCap);
    }
  }

  #fire(): void {
    this.#inFlight = true;
    const transcriptSnapshot = this.#transcript;
    const priorSummarySnapshot = this.#lastSummary;
    const resolvedAnswersSnapshot =
      this.#resolvedAnswers.length > 0 ? [...this.#resolvedAnswers] : undefined;
    const input: SummarizerInput = {
      transcript_window: transcriptSnapshot,
      ...(priorSummarySnapshot !== null ? { prior_summary: priorSummarySnapshot } : {}),
      ...(resolvedAnswersSnapshot !== undefined ? { resolved_answers: resolvedAnswersSnapshot } : {}),
    };

    this.#summarizer.summarize(input).then(
      (summary) => {
        this.#inFlight = false;
        if (this.#disposed) return;
        this.#lastSummary = summary;
        this.#lastSummaryAt = this.#now();
        this.#onSummaryUpdated(summary, this.#lastSummaryAt);
      },
      (err: unknown) => {
        this.#inFlight = false;
        if (this.#disposed) return;
        // Retain prior lastSummary unchanged. Bump lastSummaryAt so a broken
        // summarizer isn't hammered on the next question (it stays "fresh" for
        // the staleness window before another attempt).
        this.#lastSummaryAt = this.#now();
        if (this.#onError !== undefined) this.#onError(err);
      },
    );
  }
}
