import { EventEmitter } from 'node:events';
import type { Utterance } from '../transcribe/contract.js';
import type { StoredUtterance, TranscriptStore } from './store.js';

export interface WindowText {
  readonly meetingId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly text: string;
  readonly utteranceCount: number;
}

export interface TranscriptWindowEvents {
  windowChanged: [WindowText];
  utteranceFinalized: [Utterance];
}

export interface TranscriptWindowOptions {
  readonly meetingId: string;
  readonly store?: TranscriptStore;
  readonly evictAfterMs?: number;
  readonly now?: () => number;
}

const DEFAULT_EVICT_AFTER_MS = 600 * 1000;

interface MemEntry {
  utterance: Utterance;
  finalAt: number | null;
}

export class TranscriptWindow extends EventEmitter<TranscriptWindowEvents> {
  readonly #meetingId: string;
  readonly #store: TranscriptStore | undefined;
  readonly #evictAfterMs: number;
  readonly #now: () => number;
  readonly #byId = new Map<string, MemEntry>();
  #currentPartial: Utterance | null = null;

  constructor(options: TranscriptWindowOptions) {
    super();
    this.#meetingId = options.meetingId;
    this.#store = options.store;
    this.#evictAfterMs = options.evictAfterMs ?? DEFAULT_EVICT_AFTER_MS;
    this.#now = options.now ?? Date.now;
  }

  push(utterance: Utterance): void {
    if (utterance.isFinal) {
      this.#pushFinal(utterance);
    } else {
      this.#pushPartial(utterance);
    }
    this.#evict();
    this.emit('windowChanged', this.windowText(30));
  }

  windowText(durationSeconds: number): WindowText {
    const nowMs = this.#now();
    const fromMs = nowMs - durationSeconds * 1000;
    const inMem = [...this.#byId.values()]
      .filter((e) => e.finalAt !== null && e.utterance.endMs >= fromMs)
      .sort((a, b) => a.utterance.startMs - b.utterance.startMs)
      .map((e) => e.utterance);

    const oldestInMem = inMem.length > 0 ? inMem[0]!.startMs : Infinity;
    let fromStore: StoredUtterance[] = [];
    if (this.#store !== undefined && fromMs < oldestInMem) {
      fromStore = this.#store.loadRange(this.#meetingId, fromMs, oldestInMem - 1);
    }

    const combined = [
      ...fromStore.map(
        (u): Utterance => ({
          utteranceId: u.utteranceId,
          text: u.text,
          isFinal: true,
          startMs: u.startMs,
          endMs: u.endMs,
          revision: u.revision,
          ...(u.speaker !== undefined && { speaker: u.speaker }),
        }),
      ),
      ...inMem,
    ];

    const partial = this.#currentPartial;
    const partialText =
      partial !== null && partial.endMs >= fromMs && partial.text.length > 0
        ? ` ${partial.text}`
        : '';

    return {
      meetingId: this.#meetingId,
      fromMs,
      toMs: nowMs,
      text: combined.map((u) => u.text).join(' ') + partialText,
      utteranceCount: combined.length + (partialText.length > 0 ? 1 : 0),
    };
  }

  clear(): void {
    this.#byId.clear();
    this.#currentPartial = null;
  }

  size(): number {
    return this.#byId.size;
  }

  /**
   * The text of the most recently finalized utterance, or null when no
   * final has landed yet. Used by the router heuristic: matching against
   * the 30s windowText would produce false positives because a single
   * tool-shaped phrase earlier in the meeting would trigger on every
   * flush. Returning only the latest finalized utterance keeps the gate
   * sensitive to the actual current question.
   */
  latestFinalUtteranceText(): string | null {
    let latest: { startMs: number; text: string } | null = null;
    for (const entry of this.#byId.values()) {
      if (entry.finalAt === null) continue;
      if (latest === null || entry.utterance.startMs > latest.startMs) {
        latest = { startMs: entry.utterance.startMs, text: entry.utterance.text };
      }
    }
    return latest?.text ?? null;
  }

  #pushPartial(utterance: Utterance): void {
    const existing = this.#byId.get(utterance.utteranceId);
    if (existing !== undefined && existing.utterance.revision >= utterance.revision) return;
    this.#currentPartial = utterance;
  }

  #pushFinal(utterance: Utterance): void {
    const existing = this.#byId.get(utterance.utteranceId);
    if (existing !== undefined) {
      if (existing.utterance.isFinal && existing.utterance.revision >= utterance.revision) {
        return;
      }
    }
    const entry: MemEntry = { utterance, finalAt: this.#now() };
    this.#byId.set(utterance.utteranceId, entry);
    this.#currentPartial = null;
    if (this.#store !== undefined) {
      this.#store.persist({ ...utterance, meetingId: this.#meetingId });
    }
    this.emit('utteranceFinalized', utterance);
  }

  #evict(): void {
    const cutoff = this.#now() - this.#evictAfterMs;
    for (const [id, entry] of this.#byId) {
      if (entry.finalAt !== null && entry.utterance.endMs < cutoff) {
        this.#byId.delete(id);
      }
    }
  }
}
