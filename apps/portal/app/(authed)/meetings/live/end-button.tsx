'use client';

import { useTransition, type ReactElement } from 'react';
import { endStuckMeetingAction } from './end-action';

/**
 * "End now" button on each live meeting card. Confirms before firing
 * because flipping a genuine in-progress meeting to completed would be
 * disruptive — the live page swaps to the post-call review shell and
 * incoming Recall transcripts would no longer mark the row recording
 * (the bot-worker's first-utterance flip is one-way; markedRecording
 * is per-runtime in-memory state, so a server restart fixes that
 * second-order issue, but we still don't want a misclick to end an
 * active meeting).
 */
export function EndMeetingButton({ meetingId }: { meetingId: string }): ReactElement {
  const [pending, startTransition] = useTransition();

  function onClick(e: React.MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const confirmed = window.confirm(
      'Mark this meeting as ended? Use this only when a meeting is stuck — the bot will be disconnected.',
    );
    if (!confirmed) return;
    startTransition(async () => {
      const result = await endStuckMeetingAction(meetingId);
      if (!result.ok) {
        window.alert(`Failed to end meeting: ${result.error}`);
      }
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-rose-300"
      title="Mark this meeting as ended (use if the bot is stuck)"
    >
      {pending ? 'Ending…' : 'End'}
    </button>
  );
}
