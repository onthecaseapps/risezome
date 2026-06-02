/**
 * One-off: reconstruct a meeting's live-pipeline activity from the DB so we can
 * see where "nothing appeared" broke — cards, syntheses (+ status), and the
 * meeting_events stream the live page subscribes to. Run:
 *   pnpm --filter @risezome/bot-worker exec tsx --env-file=.env scripts/debug-meeting.ts
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SECRET_KEY!;
const db = createClient(url, key, { auth: { persistSession: false } });

function fmt(ts: string | null): string {
  if (ts === null) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

async function main(): Promise<void> {
  const { data: meetings, error } = await db
    .from('meetings')
    .select('meeting_id, org_id, status, recall_bot_id, created_at, started_at, ended_at, error_code, error_message')
    .order('created_at', { ascending: false })
    .limit(5);
  if (error !== null) throw new Error(`meetings query failed: ${error.message}`);
  if (meetings === null || meetings.length === 0) {
    console.log('No meetings found.');
    return;
  }

  console.log('=== 5 most recent meetings ===');
  for (const m of meetings) {
    console.log(
      `${fmt(m.created_at)}  ${m.meeting_id}  status=${m.status}  bot=${m.recall_bot_id ?? '—'}  ` +
        `started=${fmt(m.started_at)} ended=${fmt(m.ended_at)}` +
        (m.error_code !== null ? `  ERROR ${m.error_code}: ${m.error_message ?? ''}` : ''),
    );
  }

  const target = meetings[0]!;
  console.log(`\n=== Drilling into most recent: ${target.meeting_id} (status=${target.status}) ===`);

  const [cards, syntheses, events] = await Promise.all([
    db.from('cards').select('card_id, source, type, title, triggered_by, surfaced_at, utterance_id').eq('meeting_id', target.meeting_id).order('surfaced_at', { ascending: true }),
    db.from('syntheses').select('synthesis_id, status, accumulated_text, citations, stop_reason, retracted_reason, error_code, error_message, created_at').eq('meeting_id', target.meeting_id).order('created_at', { ascending: true }),
    db.from('meeting_events').select('type, created_at, payload').eq('meeting_id', target.meeting_id).order('created_at', { ascending: true }),
  ]);

  console.log(`\n--- cards: ${cards.data?.length ?? 0} ---`);
  for (const c of cards.data ?? []) {
    console.log(`  ${fmt(c.surfaced_at)}  [${c.source}/${c.type}] ${c.title.slice(0, 60)}  by=${c.triggered_by} utt=${c.utterance_id ?? '—'}`);
  }

  console.log(`\n--- syntheses: ${syntheses.data?.length ?? 0} ---`);
  for (const s of syntheses.data ?? []) {
    const cites = Array.isArray(s.citations) ? s.citations.length : 0;
    console.log(
      `  ${fmt(s.created_at)}  status=${s.status}  cites=${cites}  stop=${s.stop_reason ?? '—'}` +
        (s.retracted_reason !== null ? `  retracted=${s.retracted_reason}` : '') +
        (s.error_code !== null ? `  ERROR ${s.error_code}: ${s.error_message ?? ''}` : ''),
    );
    if (s.accumulated_text && s.accumulated_text.length > 0) {
      console.log(`      text: "${s.accumulated_text.slice(0, 140)}"`);
    }
  }

  console.log(`\n--- meeting_events by type ---`);
  const byType = new Map<string, number>();
  for (const e of events.data ?? []) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  if (byType.size === 0) console.log('  (none)');
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${n}`);
  }

  // Surface any transcript/status events so we can tell if audio→transcription ran.
  const statusEvents = (events.data ?? []).filter((e) => e.type === 'meetingStatus');
  console.log(`\n--- meetingStatus transitions: ${statusEvents.length} ---`);
  for (const e of statusEvents) {
    console.log(`  ${fmt(e.created_at)}  ${JSON.stringify(e.payload).slice(0, 120)}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
