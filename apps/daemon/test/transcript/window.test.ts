import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { openCorpusDb } from '../../src/corpus/db.js';
import { migrate } from '../../src/corpus/migrate.js';
import { TranscriptStore } from '../../src/transcript/store.js';
import { TranscriptWindow } from '../../src/transcript/window.js';
import type { Utterance } from '@risezome/engine/transcribe';

interface Harness {
  db: DatabaseType;
  store: TranscriptStore;
  dir: string;
}

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'risezome-window-'));
  const db = await openCorpusDb({ path: join(dir, 'risezome.db') });
  await migrate(db);
  const store = new TranscriptStore(db);
  store.ensureMeeting('m:1', null, 0);
  return { db, store, dir };
}

function teardown(h: Harness): void {
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true });
}

function utt(
  id: string,
  text: string,
  startMs: number,
  endMs: number,
  isFinal: boolean,
  revision = 0,
): Utterance {
  return { utteranceId: id, text, isFinal, startMs, endMs, revision };
}

describe('TranscriptWindow', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setup();
  });

  afterEach(() => {
    teardown(h);
  });

  it('window query concatenates 3 finalized utterances in start-order', () => {
    const now = 100_000;
    const w = new TranscriptWindow({ meetingId: 'm:1', store: h.store, now: () => now });
    w.push(utt('u1', 'first', 70_000, 71_000, true));
    w.push(utt('u2', 'second', 80_000, 81_000, true));
    w.push(utt('u3', 'third', 95_000, 96_000, true));
    const text = w.windowText(60).text;
    expect(text).toBe('first second third');
  });

  it('replacing a partial with a final keeps the final text', () => {
    const now = 100_000;
    const w = new TranscriptWindow({ meetingId: 'm:1', store: h.store, now: () => now });
    w.push(utt('u1', 'hel', 90_000, 90_500, false, 0));
    w.push(utt('u1', 'hello world', 90_000, 91_000, true, 1));
    expect(w.windowText(30).text).toBe('hello world');
  });

  it('query for 1s window over a 3s-old utterance returns empty', () => {
    const now = 100_000;
    const w = new TranscriptWindow({ meetingId: 'm:1', store: h.store, now: () => now });
    w.push(utt('u1', 'old', 96_000, 97_000, true));
    expect(w.windowText(1).text.trim()).toBe('');
  });

  it('partial appears appended to final window text', () => {
    const now = 100_000;
    const w = new TranscriptWindow({ meetingId: 'm:1', store: h.store, now: () => now });
    w.push(utt('u1', 'hello', 95_000, 96_000, true));
    w.push(utt('u2', 'world', 97_000, 100_000, false));
    expect(w.windowText(10).text.trim()).toBe('hello world');
  });

  it('bounded eviction: 1000 utterances over an hour leaves the in-memory map under the cap', () => {
    let now = 0;
    const w = new TranscriptWindow({
      meetingId: 'm:1',
      store: h.store,
      now: () => now,
      evictAfterMs: 60 * 1000,
    });
    for (let i = 0; i < 1000; i++) {
      now = i * 3_600;
      w.push(utt(`u${String(i)}`, `t${String(i)}`, now - 100, now, true));
    }
    // With ~60s eviction window and i*3.6s strides, only ~17 utterances should remain.
    expect(w.size()).toBeLessThan(30);
  });

  it('falls back to SQLite for utterances outside the in-memory window', () => {
    let now = 0;
    const w = new TranscriptWindow({
      meetingId: 'm:1',
      store: h.store,
      now: () => now,
      evictAfterMs: 60 * 1000,
    });
    // Push 1000 utterances spaced 3.6s apart so older ones get evicted.
    for (let i = 0; i < 1000; i++) {
      now = i * 3_600;
      w.push(utt(`u${String(i)}`, `t${String(i)}`, now - 100, now, true));
    }
    // Query the full hour-plus-then-some window — must reach the persistent store for old utterances.
    const out = w.windowText(60 * 60);
    expect(out.utteranceCount).toBeGreaterThan(100);
    // 't0' is far older than the eviction window but should appear via SQLite fallback.
    expect(out.text).toContain('t0');
  });

  it('restart simulation: a new window loads persisted utterances from SQLite', () => {
    const now = 1000;
    const w1 = new TranscriptWindow({ meetingId: 'm:1', store: h.store, now: () => now });
    w1.push(utt('u1', 'persisted', 900, 990, true));

    // New TranscriptWindow with the same store (simulates daemon restart mid-meeting).
    const w2 = new TranscriptWindow({ meetingId: 'm:1', store: h.store, now: () => now });
    const text = w2.windowText(60).text.trim();
    expect(text).toBe('persisted');
  });

  it('clear() empties the in-memory map (meeting-end cleanup)', () => {
    const now = 100_000;
    const w = new TranscriptWindow({ meetingId: 'm:1', store: h.store, now: () => now });
    w.push(utt('u1', 'hello', 99_000, 99_500, true));
    expect(w.size()).toBe(1);
    w.clear();
    expect(w.size()).toBe(0);
  });

  it('duplicate utteranceId + same revision is a no-op', () => {
    const now = 100_000;
    const w = new TranscriptWindow({ meetingId: 'm:1', store: h.store, now: () => now });
    const events: string[] = [];
    w.on('utteranceFinalized', (u) => events.push(u.utteranceId));
    w.push(utt('u1', 'hello', 99_000, 99_500, true, 0));
    w.push(utt('u1', 'hello', 99_000, 99_500, true, 0));
    expect(events).toEqual(['u1']);
  });

  it('emits windowChanged on every push', () => {
    const now = 100_000;
    const w = new TranscriptWindow({ meetingId: 'm:1', store: h.store, now: () => now });
    let count = 0;
    w.on('windowChanged', () => (count += 1));
    w.push(utt('u1', 'one', 99_000, 99_500, true));
    w.push(utt('u2', 'two', 99_500, 100_000, false));
    expect(count).toBe(2);
  });
});
