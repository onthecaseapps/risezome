import type {
  CardEvent,
  CardRetracted,
  CardUpdated,
  GapEvent,
  SynthesisDeltaEvent,
  SynthesisDoneEvent,
  SynthesisRetractedEvent,
  SynthesisStartEvent,
} from './types.js';
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

interface SynthesisRecord {
  readonly synthesisId: string;
  readonly el: HTMLElement;
  readonly bodyEl: HTMLElement;
  readonly cursorEl: HTMLElement;
  readonly citationsEl: HTMLElement;
  readonly sourceCardIds: readonly string[];
  accumulatedText: string;
  readonly renderedCitations: Set<number>;
  /**
   * Cards consolidated into this synthesis on synthesisDone. We track the
   * record + the original sibling that came right after it in #streamEl, so
   * if the synthesis is later retracted/erred we can restore each card to
   * its original stream position instead of always sending it to the top.
   */
  consolidated: { record: CardRecord; nextSibling: ChildNode | null }[];
  /** Container the consolidated raw cards live inside while consolidated. */
  consolidatedContainer: HTMLElement | null;
}

export class Sidebar {
  readonly #streamEl: HTMLElement;
  readonly #pinnedEl: HTMLElement;
  readonly #announceEl: HTMLElement | null;
  readonly #onPin: (cardId: string) => void;
  readonly #onUnpin: (cardId: string) => void;
  readonly #onLogGap: (gapId: string) => void;
  readonly #onDismissGap: (gapId: string) => void;
  readonly #cards = new Map<string, CardRecord>();
  readonly #gaps = new Map<string, HTMLElement>();
  readonly #syntheses = new Map<string, SynthesisRecord>();

  constructor(options: SidebarOptions) {
    this.#streamEl = options.streamEl;
    this.#pinnedEl = options.pinnedEl;
    this.#announceEl =
      this.#streamEl.ownerDocument.getElementById('synthesis-announce');
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

  visibleSynthesisCount(): number {
    return this.#syntheses.size;
  }

  // --- Synthesis card lifecycle ---

  renderSynthesisStart(start: SynthesisStartEvent): void {
    if (this.#syntheses.has(start.synthesisId)) return;
    const doc = this.#streamEl.ownerDocument;
    const el = doc.createElement('article');
    el.className = 'card synthesis';
    el.dataset['synthesisId'] = start.synthesisId;
    // aria-live="off" — per-token DOM mutations would spam SR; the
    // #synthesis-announce sibling element receives the final text once.
    el.setAttribute('aria-live', 'off');

    const header = doc.createElement('div');
    header.className = 'header';
    const label = doc.createElement('span');
    label.className = 'ai-label';
    label.textContent = 'AI SUMMARY';
    header.appendChild(label);

    const bodyEl = doc.createElement('div');
    bodyEl.className = 'synthesis-body';

    const cursorEl = doc.createElement('span');
    cursorEl.className = 'synthesis-cursor';
    cursorEl.textContent = '▊';
    cursorEl.setAttribute('aria-hidden', 'true');

    const citationsEl = doc.createElement('div');
    citationsEl.className = 'citations';

    el.append(header, bodyEl, cursorEl, citationsEl);
    this.#streamEl.insertBefore(el, this.#streamEl.firstChild);

    this.#syntheses.set(start.synthesisId, {
      synthesisId: start.synthesisId,
      el,
      bodyEl,
      cursorEl,
      citationsEl,
      sourceCardIds: start.sourceCardIds,
      accumulatedText: '',
      renderedCitations: new Set(),
      consolidated: [],
      consolidatedContainer: null,
    });
  }

  appendSynthesisDelta(delta: SynthesisDeltaEvent): void {
    const rec = this.#syntheses.get(delta.synthesisId);
    if (rec === undefined) return;
    rec.accumulatedText += delta.delta;
    // Append text content cheaply — never re-render the whole body.
    rec.bodyEl.textContent = rec.accumulatedText;
    // Eager citation chip render: scan accumulated text for new [N] tokens.
    for (const match of rec.accumulatedText.matchAll(/\[(\d+)\]/g)) {
      const n = Number(match[1]);
      if (
        Number.isInteger(n)
        && n >= 1
        && n <= rec.sourceCardIds.length
        && !rec.renderedCitations.has(n)
      ) {
        rec.renderedCitations.add(n);
        this.#renderCitationChip(rec, n);
      }
    }
  }

  finalizeSynthesis(done: SynthesisDoneEvent): void {
    const rec = this.#syntheses.get(done.synthesisId);
    if (rec === undefined) return;
    // Remove the cursor.
    rec.cursorEl.remove();
    // Reconcile chips: drop any chip not in the final citation set.
    const finalSet = new Set(done.citations);
    const chips = Array.from(rec.citationsEl.querySelectorAll<HTMLElement>('.citation-chip'));
    for (const chip of chips) {
      const n = Number(chip.dataset['rank']);
      if (!finalSet.has(n)) {
        chip.remove();
        rec.renderedCitations.delete(n);
      }
    }
    // Announce the final text once.
    if (this.#announceEl !== null) {
      this.#announceEl.textContent = rec.accumulatedText;
    }
    // Consolidate: move the raw source cards from the main stream into a
    // grid inside the synthesis card. Restored to original positions on
    // synthesis removal (error/retract) so the user never loses access.
    this.#consolidateRawCards(rec);
  }

  removeSynthesis(synthesisId: string): void {
    const rec = this.#syntheses.get(synthesisId);
    if (rec === undefined) return;
    // Return any consolidated cards back to the main stream before tearing
    // the synthesis card down — the user expects the raw retrieval cards to
    // remain visible when synthesis fails/refuses/retracts.
    this.#deconsolidateRawCards(rec);
    rec.el.remove();
    this.#syntheses.delete(synthesisId);
  }

  retractSynthesis(retracted: SynthesisRetractedEvent): void {
    this.removeSynthesis(retracted.synthesisId);
  }

  // Moves the raw source cards out of #streamEl and into a grid inside the
  // synthesis card. Pinned cards (which live in #pinnedEl) are skipped — the
  // user already decided to keep them visible, no need to duplicate.
  #consolidateRawCards(rec: SynthesisRecord): void {
    const doc = this.#streamEl.ownerDocument;
    const movable: { record: CardRecord; nextSibling: ChildNode | null }[] = [];
    for (const cardId of rec.sourceCardIds) {
      const cardRec = this.#cards.get(cardId);
      if (cardRec === undefined) continue;
      if (cardRec.pinned) continue;
      // Only consolidate cards currently in the stream — if a card was
      // retracted before we got here, its el is detached and we skip.
      if (cardRec.el.parentNode !== this.#streamEl) continue;
      movable.push({ record: cardRec, nextSibling: cardRec.el.nextSibling });
    }
    if (movable.length === 0) return;

    const container = doc.createElement('div');
    container.className = 'synthesis-sources';
    const label = doc.createElement('div');
    label.className = 'synthesis-sources-label';
    label.textContent = `Sources (${String(movable.length)})`;
    container.appendChild(label);
    const grid = doc.createElement('div');
    grid.className = 'synthesis-sources-grid';
    container.appendChild(grid);

    for (const entry of movable) {
      entry.record.el.classList.add('consolidated');
      grid.appendChild(entry.record.el);
    }
    rec.el.appendChild(container);
    rec.consolidated = movable;
    rec.consolidatedContainer = container;
  }

  // Restores consolidated cards to their original positions in #streamEl
  // before the synthesis card disappears. Each card is reinserted before
  // the sibling it was originally followed by, so the user perceives the
  // stream state as if no consolidation had ever happened.
  #deconsolidateRawCards(rec: SynthesisRecord): void {
    for (const entry of rec.consolidated) {
      entry.record.el.classList.remove('consolidated');
      // If the original next sibling still exists in the stream, insert
      // before it; otherwise append. nextSibling may have been removed
      // (e.g., retracted) in the interim.
      if (
        entry.nextSibling !== null
        && entry.nextSibling.parentNode === this.#streamEl
      ) {
        this.#streamEl.insertBefore(entry.record.el, entry.nextSibling);
      } else {
        this.#streamEl.appendChild(entry.record.el);
      }
    }
    rec.consolidated = [];
    if (rec.consolidatedContainer !== null) {
      rec.consolidatedContainer.remove();
      rec.consolidatedContainer = null;
    }
  }

  #renderCitationChip(rec: SynthesisRecord, rank: number): void {
    const doc = this.#streamEl.ownerDocument;
    const cardId = rec.sourceCardIds[rank - 1];
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = 'citation-chip';
    chip.dataset['rank'] = String(rank);
    if (typeof cardId === 'string') chip.dataset['cardId'] = cardId;
    chip.textContent = `[${String(rank)}]`;
    chip.addEventListener('click', () => {
      if (typeof cardId !== 'string') return;
      const target = doc.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    rec.citationsEl.appendChild(chip);
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
