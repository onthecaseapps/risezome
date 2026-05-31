import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';
import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServerClient } from '../../../../_lib/supabase-server';

/**
 * Post-meeting review page. Renders cards/syntheses/gaps for a completed
 * (or otherwise-terminal) meeting in static form — no Realtime
 * subscription, no reducer. Server-only.
 *
 * Accessible from:
 *   - /upcoming, once the meeting transitions to `completed` (via the
 *     U10 webhook handler on `bot.call_ended`)
 *   - the live page redirects here when status === 'completed'
 *
 * Read model:
 *   - meetings row (status, started_at, ended_at, recall_bot_id)
 *   - calendar_events row for the title + start/end
 *   - cards (sorted: pinned first by pinned_at, then by surfaced_at DESC)
 *   - syntheses (only status='done', sorted by created_at)
 *
 * Retracted cards/syntheses are excluded from the main listing but
 * accessible via a "show dismissed" toggle (deferred to a follow-up).
 */

interface PageProps {
  params: Promise<{ meetingId: string }>;
}

interface ReviewCard {
  card_id: string;
  doc_id: string | null;
  source: string;
  type: string;
  title: string;
  snippet: string;
  url: string | null;
  pinned: boolean;
  pinned_at: string | null;
  surfaced_at: string;
}

interface ReviewSynthesis {
  synthesis_id: string;
  source_card_ids: string[];
  accumulated_text: string;
  citations: number[];
  created_at: string;
}

export default async function ReviewPage(props: PageProps): Promise<ReactElement> {
  const { meetingId } = await props.params;
  const { orgId } = await requireAuthedUserWithOrg();

  const supabase = await createServerClient();
  const { data: meeting } = await supabase
    .from('meetings')
    .select('meeting_id, org_id, status, started_at, ended_at, calendar_event_id')
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (meeting === null) notFound();

  let title = 'Meeting';
  if (meeting.calendar_event_id !== null) {
    const { data: calEvent } = await supabase
      .from('calendar_events')
      .select('title')
      .eq('id', meeting.calendar_event_id)
      .maybeSingle();
    if (calEvent !== null && typeof calEvent.title === 'string' && calEvent.title.length > 0) {
      title = calEvent.title;
    }
  }

  const { data: cardRows } = await supabase
    .from('cards')
    .select(
      'card_id, doc_id, source, type, title, snippet, url, pinned, pinned_at, surfaced_at',
    )
    .eq('meeting_id', meetingId)
    .is('retracted_at', null)
    .order('pinned', { ascending: false })
    .order('pinned_at', { ascending: false, nullsFirst: false })
    .order('surfaced_at', { ascending: false });
  const cards = (cardRows ?? []) as ReviewCard[];
  const pinnedCards = cards.filter((c) => c.pinned);
  const unpinnedCards = cards.filter((c) => !c.pinned);

  const { data: synthRows } = await supabase
    .from('syntheses')
    .select('synthesis_id, source_card_ids, accumulated_text, citations, created_at')
    .eq('meeting_id', meetingId)
    .eq('status', 'done')
    .is('retracted_at', null)
    .order('created_at', { ascending: false });
  const syntheses = (synthRows ?? []) as ReviewSynthesis[];

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <a href="/upcoming" className="text-xs text-muted hover:text-fg">
          ← Upcoming
        </a>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1.5 text-sm text-muted">
          <StatusBadge status={meeting.status as string} /> ·{' '}
          {formatRange(meeting.started_at as string | null, meeting.ended_at as string | null)}
        </p>
      </header>

      {syntheses.length > 0 ? (
        <section className="mb-10">
          <SectionLabel label="Syntheses" count={syntheses.length} />
          <ul className="flex flex-col gap-3">
            {syntheses.map((s) => (
              <li key={s.synthesis_id}>
                <SynthesisRow synth={s} cards={cards} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {pinnedCards.length > 0 ? (
        <section className="mb-10">
          <SectionLabel label="Pinned" count={pinnedCards.length} />
          <ul className="flex flex-col gap-3">
            {pinnedCards.map((c) => (
              <li key={c.card_id}>
                <CardRow card={c} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {unpinnedCards.length > 0 ? (
        <section>
          <SectionLabel label="Surfaced cards" count={unpinnedCards.length} />
          <ul className="flex flex-col gap-3">
            {unpinnedCards.map((c) => (
              <li key={c.card_id}>
                <CardRow card={c} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {syntheses.length === 0 && cards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-14 text-center">
          <h2 className="text-lg font-semibold tracking-tight">Nothing surfaced</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            Risezome was in the meeting but didn&apos;t find anything worth surfacing.
            That can happen on short meetings or when the corpus didn&apos;t match.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SectionLabel({ label, count }: { label: string; count?: number }): ReactElement {
  return (
    <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
      <span>{label}</span>
      {count !== undefined ? <span>· {count}</span> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: string }): ReactElement {
  const map: Record<string, { label: string; className: string }> = {
    completed: { label: 'Completed', className: 'bg-emerald-500/15 text-emerald-400' },
    failed: { label: 'Failed', className: 'bg-rose-500/15 text-rose-400' },
    recording: { label: 'In progress', className: 'bg-accent-soft text-accent' },
  };
  const v = map[status] ?? { label: status, className: 'bg-bg/60 text-muted' };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${v.className}`}
    >
      {v.label}
    </span>
  );
}

function CardRow({ card }: { card: ReviewCard }): ReactElement {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
            <span>{card.source}</span>
            <span>·</span>
            <span>{card.type}</span>
            {card.pinned ? (
              <span className="ml-1 inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">
                Pinned
              </span>
            ) : null}
          </div>
          {card.url !== null ? (
            <a
              href={card.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block truncate font-mono text-sm font-medium text-fg hover:underline"
            >
              {card.title}
            </a>
          ) : (
            <p className="mt-1 truncate font-mono text-sm font-medium text-fg">{card.title}</p>
          )}
        </div>
      </div>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-bg/60 p-3 text-xs leading-snug text-fg">
        {truncate(card.snippet, 600)}
      </pre>
    </div>
  );
}

function SynthesisRow({
  synth,
  cards,
}: {
  synth: ReviewSynthesis;
  cards: ReviewCard[];
}): ReactElement {
  // Resolve source_card_ids → titles for click-friendly citation chips.
  // source_card_ids is 1-indexed in the synthesizer prompt but our DB
  // payload stores them in the order the cards were emitted; the
  // citations array uses the same 1-indexed positions.
  const sourceById = new Map(cards.map((c) => [c.card_id, c]));
  const sources = synth.source_card_ids
    .map((id) => sourceById.get(id))
    .filter((c): c is ReviewCard => c !== undefined);

  return (
    <div className="rounded-xl border border-accent/30 bg-accent-soft/40 p-4">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-accent">Synthesis</div>
      <p className="whitespace-pre-wrap text-sm text-fg">{synth.accumulated_text}</p>
      {synth.citations.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          {synth.citations.map((idx) => {
            const c = sources[idx - 1];
            if (c === undefined) return null;
            return (
              <a
                key={idx}
                href={c.url ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-card px-2 py-1 text-accent hover:bg-accent-soft"
              >
                <span className="font-mono">[{idx}]</span>
                <span className="truncate">{c.title}</span>
              </a>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function formatRange(startIso: string | null, endIso: string | null): string {
  if (startIso === null) return 'never started';
  const start = new Date(startIso);
  if (endIso === null) {
    return `started ${start.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  const end = new Date(endIso);
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  return `${start.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · ${minutes}m`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
