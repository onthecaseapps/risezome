import type { CardEvent, CardRetracted, CardUpdated, GapEvent } from './types.js';
import { detectLanguage, highlightCode, parseSnippet } from './highlight.js';

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
    // Newest first: prepend so fresh meeting context is always at the top
    // of the stream instead of pushing the user to scroll for it.
    this.#streamEl.insertBefore(el, this.#streamEl.firstChild);
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
    this.#streamEl.insertBefore(el, this.#streamEl.firstChild);
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
    scoreLabel.textContent = formatRank(card.rank);
    if (card.rank === 1) scoreLabel.classList.add('top');
    header.append(sourceLabel, scoreLabel);

    const title = doc.createElement('div');
    title.className = 'title';
    const titleText = card.title === '' ? card.docId : card.title;
    if (typeof card.url === 'string' && card.url.length > 0) {
      const link = doc.createElement('a');
      link.href = card.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = titleText;
      title.appendChild(link);
    } else {
      title.textContent = titleText;
    }

    const snippetEl = buildSnippet(doc, card);

    const actions = doc.createElement('div');
    actions.className = 'actions';
    const pinBtn = doc.createElement('button');
    pinBtn.type = 'button';
    pinBtn.dataset.action = 'pin';
    pinBtn.textContent = 'Pin';
    pinBtn.addEventListener('click', () => this.togglePin(card.cardId));
    actions.append(pinBtn);

    el.append(header, title, snippetEl, actions);
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
    snippet.className = 'snippet prose';
    snippet.textContent = truncate(gap.contextWindow, 600);

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

function formatRank(rank: number): string {
  if (rank === 1) return 'Top match';
  return 'Match';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// Code chunks arrive with a `// path:lines\n<body>` prefix. When present,
// render the location as a separate pill and the body as a scrollable,
// syntax-highlighted block. Otherwise fall back to plain prose so issue
// titles, doc paragraphs, and other non-code snippets still read naturally.
function buildSnippet(doc: Document, card: CardEvent): HTMLElement {
  const parsed = parseSnippet(card.snippet);
  if (parsed.location === null) {
    const el = doc.createElement('div');
    el.className = 'snippet prose';
    el.textContent = truncate(card.snippet, 600);
    return el;
  }

  const wrap = doc.createElement('div');
  wrap.className = 'snippet code';

  const loc = doc.createElement('div');
  loc.className = 'code-location';
  if (typeof card.url === 'string' && card.url.length > 0) {
    const a = doc.createElement('a');
    a.href = card.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = parsed.location;
    loc.appendChild(a);
  } else {
    loc.textContent = parsed.location;
  }
  wrap.appendChild(loc);

  const pre = doc.createElement('pre');
  pre.className = 'code-block';
  const codeEl = doc.createElement('code');
  const language = detectLanguage(parsed.location);
  codeEl.className = `language-${language}`;
  codeEl.innerHTML = highlightCode(parsed.body, language);
  pre.appendChild(codeEl);
  wrap.appendChild(pre);

  return wrap;
}
