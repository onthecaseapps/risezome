import type { CardEvent } from '../retrieve/contract.js';

export class MeetingSession {
  readonly meetingId: string;
  readonly #surfacedIds = new Set<string>();
  readonly #pinnedIds = new Set<string>();
  readonly #cards = new Map<string, CardEvent>();

  constructor(meetingId: string) {
    this.meetingId = meetingId;
  }

  hasSurfaced(docId: string): boolean {
    return this.#surfacedIds.has(docId);
  }

  recordSurfaced(card: CardEvent): void {
    this.#surfacedIds.add(card.docId);
    this.#cards.set(card.cardId, card);
  }

  pin(cardId: string): boolean {
    if (!this.#cards.has(cardId)) return false;
    this.#pinnedIds.add(cardId);
    return true;
  }

  unpin(cardId: string): boolean {
    return this.#pinnedIds.delete(cardId);
  }

  isPinned(cardId: string): boolean {
    return this.#pinnedIds.has(cardId);
  }

  pinnedCards(): CardEvent[] {
    return [...this.#pinnedIds]
      .map((id) => this.#cards.get(id))
      .filter((c): c is CardEvent => c !== undefined);
  }

  surfacedCount(): number {
    return this.#surfacedIds.size;
  }

  clear(): void {
    this.#surfacedIds.clear();
    this.#pinnedIds.clear();
    this.#cards.clear();
  }
}
