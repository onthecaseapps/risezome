'use client';

import { Fragment, useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { useAppState } from '../state/app-state';
import type { TranscriptUtterance } from '../types';

/**
 * Running transcript. Presentational + pure: takes an utterance list and
 * renders it grouped by consecutive speaker, with the in-flight partial
 * styled distinctly from settled finals. The live page drives it from reducer
 * state via {@link LiveTranscriptPanel}; the review page passes the full
 * static list directly.
 *
 * `marker` is an optional per-utterance prefix slot — the review page injects
 * a clickable synthesis anchor at utterances that triggered one (plan U8).
 */

interface SpeakerGroup {
  readonly speaker: string | null;
  readonly utterances: readonly TranscriptUtterance[];
}

/** Group consecutive utterances (sorted by startMs) under one speaker. */
function groupBySpeaker(utterances: readonly TranscriptUtterance[]): SpeakerGroup[] {
  const sorted = [...utterances].sort((a, b) => a.startMs - b.startMs);
  const groups: SpeakerGroup[] = [];
  for (const u of sorted) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.speaker === u.speaker) {
      (last.utterances as TranscriptUtterance[]).push(u);
    } else {
      groups.push({ speaker: u.speaker, utterances: [u] });
    }
  }
  return groups;
}

export interface TranscriptPanelProps {
  readonly utterances: readonly TranscriptUtterance[];
  /** Stick-to-bottom as new utterances arrive (live). Off for the static
   *  review transcript. Default false. */
  readonly autoScroll?: boolean;
  /** Optional per-utterance prefix (e.g. a synthesis anchor on review). */
  readonly marker?: (utteranceId: string) => ReactNode;
}

export function TranscriptPanel({
  utterances,
  autoScroll = false,
  marker,
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
          <p className="transcript-lines">
            {group.utterances.map((u) => (
              <Fragment key={u.utteranceId}>
                {marker !== undefined ? marker(u.utteranceId) : null}
                <span className={u.isFinal ? 'transcript-line' : 'transcript-line is-partial'}>
                  {u.text}
                  {!u.isFinal ? <span className="transcript-cursor" aria-hidden="true">▊</span> : null}
                </span>{' '}
              </Fragment>
            ))}
          </p>
        </div>
      ))}
    </div>
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
