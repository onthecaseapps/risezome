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

  const groups = groupBySpeaker(utterances);
  return (
    <div
      className="transcript"
      ref={scrollRef}
      onScroll={autoScroll ? onScroll : undefined}
      aria-label="Meeting transcript"
    >
      {groups.map((group, i) => (
        <div className="transcript-group" key={`${group.speaker ?? 'unknown'}-${String(i)}`}>
          <div className="transcript-speaker">{group.speaker ?? 'Unknown speaker'}</div>
          {group.paragraphs.map((para, pi) => (
            <p className="transcript-lines" key={pi}>
              {para.map((u) => {
                const anchored = anchoredUtteranceIds?.has(u.utteranceId) ?? false;
                const active =
                  anchored && activeUtteranceId != null && u.utteranceId === activeUtteranceId;
                const cls = [
                  'transcript-line',
                  !u.isFinal ? 'is-partial' : null,
                  anchored ? 'is-anchored' : null,
                  active ? 'is-active' : null,
                ]
                  .filter(Boolean)
                  .join(' ');
                const body = (
                  <>
                    {u.text}
                    {!u.isFinal ? (
                      <span className="transcript-cursor" aria-hidden="true">
                        ▊
                      </span>
                    ) : null}
                  </>
                );
                if (anchored && onAnchorClick !== undefined) {
                  return (
                    <Fragment key={u.utteranceId}>
                      <button
                        type="button"
                        className={`${cls} transcript-anchor`}
                        onClick={() => onAnchorClick(u.utteranceId)}
                        title="Show the summary generated here"
                        aria-pressed={active}
                      >
                        {body}
                        <span className="transcript-anchor-spark" aria-hidden="true">
                          <AnchorSparkle />
                        </span>
                      </button>{' '}
                    </Fragment>
                  );
                }
                return (
                  <Fragment key={u.utteranceId}>
                    <span className={cls}>{body}</span>{' '}
                  </Fragment>
                );
              })}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
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
