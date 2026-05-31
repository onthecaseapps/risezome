'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { saveBotSettingsAction } from './save-action';
import type { InitialSettings } from './page';

/**
 * Toggle the three workspace bot defaults. Each toggle saves
 * independently — server action returns immediately, then we flip
 * the local state on success. Optimistic state with rollback on
 * server failure (rare; RLS gates the write to org members anyway).
 *
 * Visual layout follows the design mockup: each row is title +
 * description on the left, toggle on the right.
 */
export function SettingsForm({ initial }: { initial: InitialSettings }): ReactElement {
  const [autoJoin, setAutoJoin] = useState(initial.auto_join);
  const [recordTranscribe, setRecordTranscribe] = useState(initial.record_transcribe);
  const [announceOnJoin, setAnnounceOnJoin] = useState(initial.announce_on_join);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save(field: 'auto_join' | 'record_transcribe' | 'announce_on_join', next: boolean): void {
    const previous = {
      auto_join: autoJoin,
      record_transcribe: recordTranscribe,
      announce_on_join: announceOnJoin,
    }[field];

    // Optimistic flip
    if (field === 'auto_join') setAutoJoin(next);
    if (field === 'record_transcribe') setRecordTranscribe(next);
    if (field === 'announce_on_join') setAnnounceOnJoin(next);
    setError(null);

    startTransition(async () => {
      const result = await saveBotSettingsAction({
        auto_join: field === 'auto_join' ? next : autoJoin,
        record_transcribe: field === 'record_transcribe' ? next : recordTranscribe,
        announce_on_join: field === 'announce_on_join' ? next : announceOnJoin,
      });
      if (!result.ok) {
        // Roll back
        if (field === 'auto_join') setAutoJoin(previous);
        if (field === 'record_transcribe') setRecordTranscribe(previous);
        if (field === 'announce_on_join') setAnnounceOnJoin(previous);
        setError(result.error);
      }
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <SectionLabel label="Bot defaults" />
      <SettingRow
        title="Auto-join scheduled meetings"
        description="Risezome joins every meeting on connected calendars unless you toggle it off per-meeting."
        checked={autoJoin}
        onChange={(v) => save('auto_join', v)}
        disabled={pending}
      />
      <SettingRow
        title="Record & transcribe"
        description="Capture audio for live context and a post-meeting summary."
        checked={recordTranscribe}
        onChange={(v) => save('record_transcribe', v)}
        disabled={pending}
      />
      <SettingRow
        title="Announce the bot on join"
        description="Post a short message in chat so attendees know Risezome is present."
        checked={announceOnJoin}
        onChange={(v) => save('announce_on_join', v)}
        disabled={pending}
      />
      {error !== null ? (
        <div className="border-t border-border bg-rose-500/10 px-5 py-3 text-sm text-rose-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function SectionLabel({ label }: { label: string }): ReactElement {
  return (
    <div className="border-b border-border px-5 py-3 text-xs font-medium uppercase tracking-wider text-muted">
      {label}
    </div>
  );
}

function SettingRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        <p className="mt-1 text-xs text-muted">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={`relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border border-transparent transition-colors disabled:cursor-wait disabled:opacity-60 ${
          checked ? 'bg-accent' : 'bg-border'
        }`}
      >
        <span
          aria-hidden
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          } translate-y-[1px]`}
        />
      </button>
    </div>
  );
}
