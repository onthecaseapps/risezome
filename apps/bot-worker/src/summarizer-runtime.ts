/**
 * Per-meeting rolling-summary runtime.
 *
 * Holds the rolling utterance buffer, capped transcript, pause-debounced
 * trigger, in-flight guard, and the lastSummary slot for a single
 * meeting. Both the debug WS path and the Recall production path
 * instantiate one of these per meeting — no global state, no
 * cross-meeting leakage.
 *
 * Lifecycle:
 *   const rt = new MeetingSummarizerRuntime({ summarizer, onSummaryUpdated })
 *   rt.recordUtterance("...")  // call per final utterance
 *   rt.recordUtterance("...")
 *   ...                         // summarizer fires asynchronously when
 *                               // cadence + rate-cap conditions hold
 *   rt.dispose()                // call when the meeting ends
 *
 * Trigger conditions (every recordUtterance schedules a check after a
 * pause-debounce delay D; the timer re-checks):
 *   utterancesSinceLast >= N  OR  (now - lastSummaryAt) >= M
 *   AND (now - lastSummaryAt) >= rateCapMs   (hard wall-clock floor)
 *   AND !inFlight                            (no concurrent summary call)
 *
 * Cold-start variant: until the first summary lands, lower thresholds
 * apply (N=5, M=30s, D=8s by default) so the first 1-2 minutes of a
 * meeting establish framing context faster. After the first summary
 * fires, cadence reverts to steady-state defaults.
 *
 * Re-arm-on-skip rule: if the timer fires but the in-flight guard
 * rejects, no state mutates and no retry is scheduled — the next
 * utterance's recordUtterance schedules a fresh setTimeout, which
 * picks the trigger back up. If no further utterances arrive, no
 * stale state persists.
 *
 * Mid-flight summary refresh is non-coordinated by design: in-flight
 * synthesis calls hold whatever `lastSummary` value they captured at
 * recentContext-build time. The next synthesis reads the new one. The
 * runtime owner is responsible for that atomic read at call-site (see
 * U3 in the rolling-meeting-summary plan).
 */

import type {
  MeetingSummary,
  Summarizer,
  SummarizerInput,
} from '@risezome/engine/summarize';

export interface SummarizerCadence {
  /** Trigger if this many utterances arrived since the last summary. */
  readonly utterancesThreshold: number;
  /** Trigger if this many ms elapsed since the last summary. */
  readonly timeThresholdMs: number;
  /** Pause-debounce: timer arms D ms after each utterance; rolling. */
  readonly pauseDebounceMs: number;
}

export interface MeetingSummarizerRuntimeOptions {
  readonly summarizer: Summarizer;
  /** Fires when a new summary lands. The runtime owner uses this to
   *  broadcast (debug WS) or store + log (Recall production). */
  readonly onSummaryUpdated: (summary: MeetingSummary, at: number) => void;
  /** Optional error sink. Refusals + provider errors are non-fatal; the
   *  prior `lastSummary` is retained. */
  readonly onSummarizerError?: (err: unknown) => void;
  /** Override the clock (tests). */
  readonly now?: () => number;
  /** Override the timer (tests with vitest fake timers don't need this;
   *  it's here for explicit-injection tests that don't want to mock
   *  global setTimeout). */
  readonly setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutImpl?: (handle: unknown) => void;
  /** Cadence after the first summary has fired. */
  readonly steadyStateCadence?: SummarizerCadence;
  /** Cadence before the first summary has fired (faster framing). */
  readonly coldStartCadence?: SummarizerCadence;
  /** Hard wall-clock floor between summary calls. Independent of
   *  cadence — even if both N and M trigger, calls are spaced by at
   *  least this many ms. Default 60_000. */
  readonly rateCapMs?: number;
  /** Sliding-window cap on the transcript fed to the summarizer.
   *  Default 20_000. When the transcript grows past this, the head is
   *  trimmed; prior summary carry-forward (in the prompt) preserves
   *  facts that aged out. */
  readonly transcriptCharCap?: number;
}

export const DEFAULT_STEADY_CADENCE: SummarizerCadence = {
  utterancesThreshold: 15,
  timeThresholdMs: 120_000,
  pauseDebounceMs: 10_000,
};

export const DEFAULT_COLD_START_CADENCE: SummarizerCadence = {
  utterancesThreshold: 5,
  timeThresholdMs: 30_000,
  pauseDebounceMs: 8_000,
};

export const DEFAULT_RATE_CAP_MS = 60_000;
export const DEFAULT_TRANSCRIPT_CHAR_CAP = 20_000;

export class MeetingSummarizerRuntime {
  readonly #summarizer: Summarizer;
  readonly #onSummaryUpdated: (summary: MeetingSummary, at: number) => void;
  readonly #onError: ((err: unknown) => void) | undefined;
  readonly #now: () => number;
  readonly #setTimeout: (cb: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #steadyState: SummarizerCadence;
  readonly #coldStart: SummarizerCadence;
  readonly #rateCapMs: number;
  readonly #transcriptCharCap: number;

  #transcript = '';
  #utterancesSinceLast = 0;
  #lastSummary: MeetingSummary | null = null;
  /** Wall-clock at which the last summary completed. 0 before the
   *  first call — the rate cap interprets this as "no prior call,
   *  rate cap inactive." */
  #lastSummaryAt = 0;
  #inFlight = false;
  #pendingTimer: unknown = null;
  #disposed = false;

  constructor(options: MeetingSummarizerRuntimeOptions) {
    this.#summarizer = options.summarizer;
    this.#onSummaryUpdated = options.onSummaryUpdated;
    this.#onError = options.onSummarizerError;
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
    this.#clearTimeout = options.clearTimeoutImpl ?? ((h) => {
      if (h !== null && h !== undefined) clearTimeout(h as ReturnType<typeof setTimeout>);
    });
    this.#steadyState = options.steadyStateCadence ?? DEFAULT_STEADY_CADENCE;
    this.#coldStart = options.coldStartCadence ?? DEFAULT_COLD_START_CADENCE;
    this.#rateCapMs = options.rateCapMs ?? DEFAULT_RATE_CAP_MS;
    this.#transcriptCharCap = options.transcriptCharCap ?? DEFAULT_TRANSCRIPT_CHAR_CAP;
  }

  /**
   * Record a finalized utterance. Cheap and synchronous — appends to
   * the transcript, increments the counter, and arms the pause-debounce
   * timer. Actual summarizer invocation happens later, asynchronously.
   */
  recordUtterance(text: string): void {
    if (this.#disposed) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    this.#appendToTranscript(trimmed);
    this.#utterancesSinceLast += 1;
    this.#armPauseDebounce();
  }

  /** Read the latest summary atomically. Returns null before the first
   *  summary has fired. Callers MUST read this once at the point where
   *  they construct downstream context (recentContext for synthesis,
   *  context for classifier); they MUST NOT re-read it across the
   *  async boundary or they introduce torn reads. */
  getLastSummary(): MeetingSummary | null {
    return this.#lastSummary;
  }

  /** Cancel any pending pause-debounce timer and mark the runtime
   *  disposed. Subsequent recordUtterance calls are no-ops. In-flight
   *  summarizer calls will resolve normally but their results are
   *  ignored (no callback fires after dispose). */
  dispose(): void {
    this.#disposed = true;
    if (this.#pendingTimer !== null) {
      this.#clearTimeout(this.#pendingTimer);
      this.#pendingTimer = null;
    }
  }

  #appendToTranscript(text: string): void {
    if (this.#transcript.length === 0) {
      this.#transcript = text;
    } else {
      this.#transcript = `${this.#transcript}\n${text}`;
    }
    if (this.#transcript.length > this.#transcriptCharCap) {
      // Slide the head off, but keep the recent N chars. Lose alignment
      // on the trimmed-off line — that content is the summarizer's
      // problem to carry forward via prior_summary.
      this.#transcript = this.#transcript.slice(this.#transcript.length - this.#transcriptCharCap);
    }
  }

  #armPauseDebounce(): void {
    if (this.#pendingTimer !== null) {
      this.#clearTimeout(this.#pendingTimer);
      this.#pendingTimer = null;
    }
    const cadence = this.#currentCadence();
    this.#pendingTimer = this.#setTimeout(() => {
      this.#pendingTimer = null;
      this.#maybeFire();
    }, cadence.pauseDebounceMs);
  }

  #currentCadence(): SummarizerCadence {
    return this.#lastSummary === null ? this.#coldStart : this.#steadyState;
  }

  #maybeFire(): void {
    if (this.#disposed) return;
    if (this.#inFlight) return;

    const cadence = this.#currentCadence();
    const now = this.#now();

    // Cadence trigger: enough utterances, OR enough time since last
    // summary. On the very first call (lastSummaryAt === 0), the time
    // condition fires whenever the transcript has any content — that's
    // the "first summary fires aggressively" path from the plan.
    const sinceLastMs = this.#lastSummaryAt === 0 ? Number.POSITIVE_INFINITY : now - this.#lastSummaryAt;
    const cadenceTrigger =
      this.#utterancesSinceLast >= cadence.utterancesThreshold ||
      sinceLastMs >= cadence.timeThresholdMs;
    if (!cadenceTrigger) return;

    // Hard rate cap: never call faster than rateCapMs after the prior
    // call completed. Skipped on the very first call.
    if (this.#lastSummaryAt !== 0 && now - this.#lastSummaryAt < this.#rateCapMs) return;

    if (this.#transcript.length === 0) return;

    this.#fire();
  }

  #fire(): void {
    this.#inFlight = true;
    const transcriptSnapshot = this.#transcript;
    const priorSummarySnapshot = this.#lastSummary;
    // Reset the per-window counter at fire time. If the call fails we
    // accept the counter loss — the next batch's count gets us back to
    // a trigger soon enough, and re-firing on a refused summary would
    // amplify cost on a misbehaving model.
    this.#utterancesSinceLast = 0;

    const input: SummarizerInput = priorSummarySnapshot === null
      ? { transcript_window: transcriptSnapshot }
      : { transcript_window: transcriptSnapshot, prior_summary: priorSummarySnapshot };

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
        // Retain prior lastSummary unchanged. Bump lastSummaryAt so we
        // don't immediately re-fire against a broken summarizer.
        this.#lastSummaryAt = this.#now();
        if (this.#onError !== undefined) this.#onError(err);
      },
    );
  }
}
