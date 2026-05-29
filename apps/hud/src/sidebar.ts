import type { CardEvent, CardRetracted, CardUpdated, GapEvent } from './types.js';

export interface SidebarOptions {
  readonly streamEl: HTMLElement;
  readonly pinnedEl: HTMLElement;
  readonly onPin?: (cardId: string) => void;
  readonly onUnpin?: (cardId: string) => void;
  readonly onLogGap?: (gapId: string) => void;
  readonly onDismissGap?: (gapId: string) => void;
}

interface CardRecord {
  card: CardEvent;
  el: HTMLElement;
  pinned: boolean;
}

export class Sidebar {
  readonly #streamEl: HTMLElement;
  readonly #pinnedEl: HTMLElement;
  readonly #onPin: (cardId: string) => void;
  readonly #onUnpin: (cardId: string) => void;
  readonly #onLogGap: (gapId: string) => void;
  readonly #onDismissGap: (gapId: string) => void;
  readonly #cards = new Map<string, CardRecord>();
  readonly #gaps = new Map<string, HTMLElement>();

  constructor(options: SidebarOptions) {
    this.#streamEl = options.streamEl;
    this.#pinnedEl = options.pinnedEl;
    this.#onPin = options.onPin ?? ((): void => undefined);
    this.#onUnpin = options.onUnpin ?? ((): void => undefined);
    this.#onLogGap = options.onLogGap ?? ((): void => undefined);
    this.#onDismissGap = options.onDismissGap ?? ((): void => undefined);
  }

  renderCard(card: CardEvent): void {
    if (this.#cards.has(card.cardId)) return;
    const el = this.#buildCardElement(card);
    this.#streamEl.appendChild(el);
    this.#cards.set(card.cardId, { card, el, pinned: false });
  }

  updateCard(update: CardUpdated): void {
    const rec = this.#cards.get(update.cardId);
    if (rec === undefined) return;
    if (update.score !== undefined) {
      const scoreEl = rec.el.querySelector('.score');
      if (scoreEl !== null) scoreEl.textContent = formatScore(update.score);
    }
    if (update.triggeredBy !== undefined) {
      rec.card = { ...rec.card, triggeredBy: update.triggeredBy };
      this.#refreshTriggerClass(rec);
    }
    rec.el.classList.add('updated');
    setTimeout(() => rec.el.classList.remove('updated'), 250);
  }

  retractCard(retract: CardRetracted): void {
    const rec = this.#cards.get(retract.cardId);
    if (rec === undefined) return;
    rec.el.classList.add('retracting');
    rec.el.remove();
    this.#cards.delete(retract.cardId);
  }

  renderGap(gap: GapEvent): void {
    if (this.#gaps.has(gap.gapId)) return;
    const el = this.#buildGapElement(gap);
    this.#streamEl.appendChild(el);
    this.#gaps.set(gap.gapId, el);
  }

  togglePin(cardId: string): void {
    const rec = this.#cards.get(cardId);
    if (rec === undefined) return;
    if (rec.pinned) {
      rec.pinned = false;
      this.#streamEl.appendChild(rec.el);
      rec.el.classList.remove('pinned');
      this.#onUnpin(cardId);
    } else {
      rec.pinned = true;
      this.#pinnedEl.appendChild(rec.el);
      rec.el.classList.add('pinned');
      this.#onPin(cardId);
    }
  }

  visibleCardCount(): number {
    return this.#cards.size;
  }

  visibleGapCount(): number {
    return this.#gaps.size;
  }

  #buildCardElement(card: CardEvent): HTMLElement {
    const doc = this.#streamEl.ownerDocument;
    const el = doc.createElement('article');
    el.className = 'card';
    el.dataset.cardId = card.cardId;
    if (card.triggeredBy === 'question-provisional') {
      el.classList.add('provisional');
    }

    const header = doc.createElement('div');
    header.className = 'header';
    const sourceLabel = doc.createElement('span');
    sourceLabel.className = 'source';
    sourceLabel.textContent = `${card.source} · ${card.type}`;
    const scoreLabel = doc.createElement('span');
    scoreLabel.className = 'score';
    scoreLabel.textContent = formatScore(card.score);
    header.append(sourceLabel, scoreLabel);

    const title = doc.createElement('div');
    title.className = 'title';
    title.textContent = card.title === '' ? card.docId : card.title;

    const snippet = doc.createElement('div');
    snippet.className = 'snippet';
    snippet.textContent = truncate(card.snippet, 240);

    const actions = doc.createElement('div');
    actions.className = 'actions';
    const pinBtn = doc.createElement('button');
    pinBtn.type = 'button';
    pinBtn.dataset.action = 'pin';
    pinBtn.textContent = 'Pin';
    pinBtn.addEventListener('click', () => this.togglePin(card.cardId));
    actions.append(pinBtn);

    el.append(header, title, snippet, actions);
    return el;
  }

  #buildGapElement(gap: GapEvent): HTMLElement {
    const doc = this.#streamEl.ownerDocument;
    const el = doc.createElement('article');
    el.className = 'card gap';
    el.dataset.gapId = gap.gapId;

    const header = doc.createElement('div');
    header.className = 'header';
    header.textContent = 'Gap';

    const title = doc.createElement('div');
    title.className = 'title';
    title.textContent = gap.question;

    const snippet = doc.createElement('div');
    snippet.className = 'snippet';
    snippet.textContent = truncate(gap.contextWindow, 240);

    const actions = doc.createElement('div');
    actions.className = 'actions';
    const logBtn = doc.createElement('button');
    logBtn.type = 'button';
    logBtn.textContent = 'Log gap';
    logBtn.addEventListener('click', () => this.#onLogGap(gap.gapId));
    const dismissBtn = doc.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      this.#gaps.delete(gap.gapId);
      el.remove();
      this.#onDismissGap(gap.gapId);
    });
    actions.append(logBtn, dismissBtn);

    el.append(header, title, snippet, actions);
    return el;
  }

  #refreshTriggerClass(rec: CardRecord): void {
    rec.el.classList.toggle('provisional', rec.card.triggeredBy === 'question-provisional');
  }
}

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
