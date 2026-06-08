'use client';

import { Fragment, useEffect, useRef, type ReactElement } from 'react';
import { useAppState } from '../state/app-state';
import type { TranscriptUtterance } from '../types';

/**
 * Running transcript. Presentational + pure: takes an utterance list and
 * renders it grouped by consecutive speaker, with the in-flight partial
 * styled distinctly from settled finals. The live page drives it from reducer
 * state via {@link LiveTranscriptPanel}; the review page passes the full
 * static list directly.
 *
 * Live-edge rendering follows four rules so interim speech morphs into its
 * final without flicker:
 *   1. Commit finals, never touch them again — finalized utterances render as
 *      immutable keyed blocks above the live line; they don't depend on live
 *      state, so an interim update never re-renders them.
 *   2. Diff at the word level — the live utterance's text is split into per-word
 *      <span>s keyed by index, so React reuses unchanged leading word nodes and
 *      only the changed tail repaints.
 *   3. Morph in place — the MOST RECENT utterance always occupies the dedicated
 *      live-line row (keyed by utteranceId). When it flips isFinal:false →
 *      true, the SAME React element persists in the SAME row; only its
 *      className changes, so CSS transitions its colour grey → white (~0.28s)
 *      with no node teardown. Word spans keep stable keys across the flip.
 *   4. Reserve the live line — the live-line row is always rendered (even when
 *      empty) so committing a final never shoves layout; a blinking caret marks
 *      the live edge.
 *
 * `anchoredUtteranceIds` + `onAnchorClick` let the review page highlight the
 * utterances that triggered an AI summary and open that summary on click
 * (plan U8).
 */

/** Silence (ms) between one utterance's end and the next's start that reads as
 *  a pause — a new paragraph within the same speaker's block. */
const PARAGRAPH_PAUSE_MS = 2500;

interface SpeakerGroup {
  readonly speaker: string | null;
  /** One speaker block can hold several paragraphs, split at pauses. */
  readonly paragraphs: readonly (readonly TranscriptUtterance[])[];
}

/**
 * Group consecutive utterances (sorted by startMs) under one speaker, and
 * within a speaker split into paragraphs at long pauses (gap from the previous
 * utterance's endMs to this one's startMs ≥ PARAGRAPH_PAUSE_MS).
 */
function groupBySpeaker(utterances: readonly TranscriptUtterance[]): SpeakerGroup[] {
  const sorted = [...utterances].sort((a, b) => a.startMs - b.startMs);
  const groups: { speaker: string | null; paragraphs: TranscriptUtterance[][] }[] = [];
  let prev: TranscriptUtterance | null = null;
  for (const u of sorted) {
    const group = groups[groups.length - 1];
    const gapMs = prev === null ? 0 : u.startMs - prev.endMs;
    const paused = gapMs >= PARAGRAPH_PAUSE_MS;
    // Explicit undefined check (not optional chaining) so TS narrows `group` to
    // defined in the else branches below.
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
    if (group === undefined || group.speaker !== u.speaker) {
      groups.push({ speaker: u.speaker, paragraphs: [[u]] });
    } else if (paused) {
      group.paragraphs.push([u]);
    } else {
      group.paragraphs[group.paragraphs.length - 1]!.push(u);
    }
    prev = u;
  }
  return groups;
}

export interface TranscriptPanelProps {
  readonly utterances: readonly TranscriptUtterance[];
  /** Stick-to-bottom as new utterances arrive (live). Off for the static
   *  review transcript. Default false. */
  readonly autoScroll?: boolean;
  /** Utterances that triggered an AI summary — rendered underlined + clickable
   *  (review page). */
  readonly anchoredUtteranceIds?: ReadonlySet<string>;
  /** Invoked when a highlighted (anchored) utterance is clicked. */
  readonly onAnchorClick?: (utteranceId: string) => void;
  /** The anchored utterance whose synthesis is currently open — rendered with
   *  an outlined, tinted box (review page pagination/selection). */
  readonly activeUtteranceId?: string | null;
}

/**
 * Pick the most recent utterance by startMs (ties broken by the later one
 * encountered). Candidate for the reserved live-line row.
 */
function mostRecent(
  utterances: readonly TranscriptUtterance[],
): TranscriptUtterance | null {
  let live: TranscriptUtterance | null = null;
  for (const u of utterances) {
    if (live === null || u.startMs > live.startMs) live = u;
  }
  return live;
}

export function TranscriptPanel({
  utterances,
  autoScroll = false,
  anchoredUtteranceIds,
  onAnchorClick,
  activeUtteranceId,
}: TranscriptPanelProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stick to bottom only while the user is already near the bottom, so reading
  // back through history isn't yanked forward by new speech.
  const pinnedRef = useRef(true);
  // The utteranceId currently occupying the live-line row. Tracks the in-flight
  // partial so when it finalizes we keep it in the SAME row for one more render
  // (morph in place, Rule 3) before it commits to a speaker block. Seeded finals
  // that were never interim never enter the live row, so they keep their speaker
  // heading.
  const liveIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el === null || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [utterances, autoScroll]);

  function onScroll(): void {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  if (utterances.length === 0) {
    return (
      <div className="transcript transcript-empty" aria-live="off">
        <p className="transcript-empty-hint">Waiting for the conversation to start…</p>
      </div>
    );
  }

  // Only the live page (autoScroll) reserves a live-line row and morphs interim
  // → final in place. The static review transcript has no in-flight edge: it
  // renders every utterance as a committed final (so jump-to-moment anchors
  // stay in DOM order and nothing shows a caret).
  //
  // The live-line row holds the most recent utterance ONLY while it is an
  // in-flight partial, OR for the single render in which that same partial
  // settles to final (so the partial → final morph animates on the same element
  // rather than jumping up into a committed block). A final that was never the
  // live partial — e.g. a seeded prior transcript — stays a committed block with
  // its speaker heading. Committed blocks NEVER include the live-row utterance,
  // so the morph happens in place (Rule 3) with no duplicate line.
  let live: TranscriptUtterance | null = null;
  if (autoScroll) {
    const recent = mostRecent(utterances);
    if (recent !== null) {
      const wasLive = liveIdRef.current === recent.utteranceId;
      if (!recent.isFinal || wasLive) live = recent;
    }
  }
  // Remember the live id for the next render: keep it pinned while still
  // in-flight; once it has settled (final + was the live line) release it so the
  // next render commits it to a speaker block.
  liveIdRef.current = live !== null && !live.isFinal ? live.utteranceId : null;
  const committed = utterances.filter((u) => u.utteranceId !== live?.utteranceId);
  const groups = groupBySpeaker(committed);

  return (
    <div
      className="transcript"
      ref={scrollRef}
      onScroll={autoScroll ? onScroll : undefined}
      aria-label="Meeting transcript"
    >
      {/* Rule 1: committed finals as immutable keyed blocks. */}
      {groups.map((group, i) => (
        <div className="transcript-group" key={`${group.speaker ?? 'unknown'}-${String(i)}`}>
          <div className="transcript-speaker">{group.speaker ?? 'Unknown speaker'}</div>
          {group.paragraphs.map((para, pi) => (
            <p className="transcript-lines" key={pi}>
              {para.map((u) => (
                <Fragment key={u.utteranceId}>
                  <TranscriptLine
                    utterance={u}
                    anchored={anchoredUtteranceIds?.has(u.utteranceId) ?? false}
                    active={
                      (anchoredUtteranceIds?.has(u.utteranceId) ?? false) &&
                      activeUtteranceId != null &&
                      u.utteranceId === activeUtteranceId
                    }
                    onAnchorClick={onAnchorClick}
                    live={false}
                  />{' '}
                </Fragment>
              ))}
            </p>
          ))}
        </div>
      ))}

      {/* Rule 4: the live-line row is ALWAYS reserved so committing a final
          doesn't shove layout. It shows the in-flight partial OR the just-
          settled final (morphing in place), plus a blinking caret. */}
      <div className="transcript-live-line" aria-live="polite">
        {live !== null ? (
          <p className="transcript-lines">
            {live.speaker !== null ? (
              <span className="transcript-live-speaker">{live.speaker}: </span>
            ) : null}
            <TranscriptLine
              key={live.utteranceId}
              utterance={live}
              anchored={anchoredUtteranceIds?.has(live.utteranceId) ?? false}
              active={
                (anchoredUtteranceIds?.has(live.utteranceId) ?? false) &&
                activeUtteranceId != null &&
                live.utteranceId === activeUtteranceId
              }
              onAnchorClick={onAnchorClick}
              live
            />
          </p>
        ) : null}
      </div>
    </div>
  );
}

interface TranscriptLineProps {
  readonly utterance: TranscriptUtterance;
  readonly anchored: boolean;
  readonly active: boolean;
  readonly onAnchorClick: ((utteranceId: string) => void) | undefined;
  /** True when this line occupies the reserved live-line row — it renders the
   *  blinking caret and animates colour when it settles from interim to final. */
  readonly live: boolean;
}

/**
 * One transcript line, shared by committed finals and the live row. Keying the
 * element by utteranceId (done by the caller) means when an interim finalizes
 * the SAME React element persists; only `is-partial` drops and `is-finalizing`
 * is added, so CSS transitions its colour grey → white in place (Rule 3).
 *
 * Rule 2: the text is rendered as per-word <span>s keyed by word index, so as
 * the interim grows React reuses the unchanged leading word nodes and repaints
 * only the changed tail. Preserves the `data-start-ms` / `data-utterance-id`
 * attributes the review page's jump-to-moment feature targets.
 */
function TranscriptLine({
  utterance: u,
  anchored,
  active,
  onAnchorClick,
  live,
}: TranscriptLineProps): ReactElement {
  const cls = [
    'transcript-line',
    !u.isFinal ? 'is-partial' : null,
    // A live-row line that has settled to final animates grey → white.
    live && u.isFinal ? 'is-finalizing' : null,
    anchored ? 'is-anchored' : null,
    active ? 'is-active' : null,
  ]
    .filter(Boolean)
    .join(' ');

  // The blinking caret marks an in-flight (non-final) line at the live edge.
  // A line that has settled to final loses the caret.
  //
  // Rule 2 (word-level diff) applies to the in-flight (non-final) live line: its
  // text is rendered as per-word spans so React reuses unchanged leading word
  // nodes as the interim grows. Once it settles to final (and for all committed
  // finals) the text renders as a single node — no per-word DOM churn, and the
  // text stays one node for downstream text matching / selection.
  //
  // Rule 3 (morph in place) holds across that flip because the SAME
  // `.transcript-line` element persists (keyed by utteranceId by the caller);
  // only `is-partial` drops off, so the line's colour transitions grey → white
  // via CSS on the same element even though its children reconcile.
  // The live row renders its text through an IMPERATIVE per-word differ
  // (LiveWords): new tail words fade in, a word the final corrects flashes, and
  // the whole line morphs grey → white in place on commit — none of which
  // React's declarative reconciliation produces. Committed finals render plain
  // text (one node, selectable, and the jump-to-moment anchors target the line).
  const body = (
    <>
      {live ? <LiveWords text={u.text} commit={u.isFinal} /> : u.text}
      {!u.isFinal ? (
        <span className="transcript-cursor" aria-hidden="true">
          ▊
        </span>
      ) : null}
    </>
  );

  if (anchored && onAnchorClick !== undefined) {
    return (
      <button
        type="button"
        className={`${cls} transcript-anchor`}
        onClick={() => onAnchorClick(u.utteranceId)}
        title="Show the summary generated here"
        aria-pressed={active}
        data-utterance-id={u.utteranceId}
        data-start-ms={u.startMs}
      >
        {body}
        <span className="transcript-anchor-spark" aria-hidden="true">
          <AnchorSparkle />
        </span>
      </button>
    );
  }

  return (
    <span className={cls} data-utterance-id={u.utteranceId} data-start-ms={u.startMs}>
      {body}
    </span>
  );
}

function tokenize(s: string): string[] {
  const t = s.trim();
  return t.length > 0 ? t.split(/\s+/) : [];
}

/**
 * The core no-flash technique, ported from the "Streaming Transcript Pattern"
 * design. Reconcile `bodyEl`'s per-word spans against `words` IMPERATIVELY:
 *   - unchanged leading words keep their exact DOM node (never repaint) — Rule 2;
 *   - a new tail word is appended with `is-in` (opacity 0), then a rAF removes it
 *     so it fades in rather than popping;
 *   - a word whose text changed is corrected in place; on the FINAL it also
 *     flashes (`is-hit`, an accent wash that fades) to show what the final fixed;
 *   - surplus trailing spans are dropped;
 *   - on `commit` every word gets `is-final`, morphing grey → white in place
 *     (Rule 3) with no node teardown.
 * State is driven by direct per-element classes (not a parent swap) so the CSS
 * transitions reliably fire.
 */
function renderWordsInto(bodyEl: HTMLElement, words: readonly string[], commit: boolean): void {
  const existing = Array.from(bodyEl.querySelectorAll<HTMLElement>('.transcript-word'));
  const max = Math.max(words.length, existing.length);
  for (let i = 0; i < max; i += 1) {
    const span = existing[i];
    if (i >= words.length) {
      span?.remove(); // surplus → drop
      continue;
    }
    const want = (i > 0 ? ' ' : '') + words[i]!;
    if (span === undefined) {
      const s = document.createElement('span');
      s.className = 'transcript-word is-in';
      s.textContent = want;
      bodyEl.appendChild(s);
      requestAnimationFrame(() => s.classList.remove('is-in')); // fade the new tail word in
    } else if (span.textContent !== want) {
      span.textContent = want; // word changed → correct in place
      if (commit) {
        span.classList.add('is-hit');
        requestAnimationFrame(() => span.classList.remove('is-hit')); // flash the correction
      }
    }
  }
  if (commit) {
    bodyEl.querySelectorAll('.transcript-word').forEach((w) => w.classList.add('is-final')); // grey → white
  }
}

/**
 * Imperatively rendered word body for the live row (Rule 2/3). Owns its span and
 * reconciles word-by-word on each text/commit change via {@link renderWordsInto}.
 * Only the transient live line uses this; committed finals are plain React text.
 */
function LiveWords({ text, commit }: { readonly text: string; readonly commit: boolean }): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el !== null) renderWordsInto(el, tokenize(text), commit);
  }, [text, commit]);
  return <span ref={ref} className="transcript-words" />;
}

/** Small sparkle marking an anchored question (one that produced an answer). */
function AnchorSparkle(): ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3l1.7 4.5L18 9l-4.3 1.5L12 15l-1.7-4.5L6 9l4.3-1.5z" />
    </svg>
  );
}

/**
 * Live transcript: reads utterances from the reducer + auto-scrolls. Mounted
 * inside an AppStateProvider (the live meeting page).
 */
export function LiveTranscriptPanel(): ReactElement {
  const state = useAppState();
  const utterances = Array.from(state.transcript.values());
  return <TranscriptPanel utterances={utterances} autoScroll />;
}
